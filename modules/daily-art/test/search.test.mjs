import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { test } from 'node:test'
import { searchKonachan } from '../lib/konachan.mjs'
import { registerSearch } from '../lib/search.mjs'
import { imageKeys, openImageDelivery } from '../lib/image-delivery.mjs'
import { startDailyArt } from '../index.mjs'

async function waitFor(predicate) {
  for (let i = 0; i < 100; i++) { if (predicate()) return; await delay(5) }
  assert.fail('队列未完成')
}

test('bare commands send one random unseen Safe image with a short example for each source', async t => {
  const dir = mkdtempSync(join(tmpdir(), 'daily-art-random-'))
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  const imageDelivery = openImageDelivery(join(dir, 'history.json'), [])
  const chatId = 'private:11'
  const repeated = Buffer.from('already delivered image')
  imageDelivery.reserve(chatId, [{ keys: ['yandere:1'] }, { keys: imageKeys('konachan:1', undefined, repeated) }])
  const replies = new Map(), sends = [], queries = []
  let handler
  registerSearch({
    config: () => ({ enabled: true, ownerQQ: '11' }), settings: () => ({}), log: {}, onDispose() {},
    on(_event, fn) { handler = fn },
    ask: async () => { throw new Error('bare search must not ask the model') },
    reply: async (msg, text) => replies.set(msg.messageId, text),
    core: { hub: { sendSegments: async (_chat, segments) => {
      assert.equal(segments.length, 1)
      sends.push(Buffer.from(segments[0].data.file.slice(9), 'base64').toString())
      return { message_id: 1 }
    } } },
  }, {
    imageDelivery,
    search: (args, options) => searchKonachan(args, { ...options, fetchPosts: async url => {
      queries.push(url.searchParams.get('tags'))
      const origin = options.source === 'yandere' ? 'https://files.yande.re' : 'https://konachan.net'
      const posts = ['e', 's', 's', 's'].map((rating, i) => ({
        id: i, rating, score: -2, width: 10, height: 10, sample_url: origin + '/' + i + '.jpg',
      }))
      posts[0].id = 99
      return Response.json(url.searchParams.get('page') === '1' ? posts : [])
    } }),
    download: async url => url.endsWith('/2.jpg') ? repeated : Buffer.from(url),
  })
  for (const command of ['yande找图', 'konachan找图']) {
    await handler({ kind: 'private', chatId, userId: '11', messageId: command, text: command })
    await waitFor(() => replies.has(command))
    assert.match(replies.get(command), /1\. s · -2 分/)
    assert.ok(replies.get(command).includes('筛选示例「' + command + ' 风景 最近一周 分数30以上」'))
  }
  assert.deepEqual(sends, ['https://files.yande.re/3.jpg', 'https://konachan.net/3.jpg'])
  assert.ok(queries.length && queries.every(tags => tags === 'rating:s order:random'))
})

test('scheduled pushes and find-image share persistent delivery history without blocking other chats', async t => {
  const dir = mkdtempSync(join(tmpdir(), 'daily-art-image-delivery-'))
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  const dataDir = name => join(dir, name)
  const legacy = dataDir('delivery-yandere.json')
  writeFileSync(legacy, JSON.stringify({
    day: '2026-11-08', used: ['yandere:1'],
    slots: { 9: { images: [{ key: 'yandere:1' }], recipients: { 'group:20000': 'sent', 'group:21000': 'pending' } } },
  }))
  const open = () => openImageDelivery(dataDir('image-delivery.json'), [legacy])
  const config = { enabled: true, ownerQQ: '11', allow: { groups: ['20000', '21000'] } }
  const settings = { enabled: true, pushTimes: '09:00', pushCount: 1, groupWhitelist: '20000' }
  const replies = new Map(), sends = []
  let handler, finishSend
  const pendingReceipt = new Promise(resolve => { finishSend = resolve })
  const api = {
    config: () => config, settings: () => settings, dataDir, onDispose() {}, every() {}, later() {},
    log: { warn() {}, info() {} }, on(_event, fn) { handler = fn },
    reply: async (msg, text) => replies.set(msg.messageId, text),
    core: { hub: { sendSegments: async (chatId, segments) => {
      const bytes = Buffer.from(segments[0].data.file.slice(9), 'base64').toString()
      sends.push([chatId, bytes])
      return bytes === 'scheduled' ? pendingReceipt : { message_id: 1 }
    } } },
  }
  const post = (source, id) => ({
    id, rating: 's', score: 50, width: 100, height: 200, tags: '',
    sample_url: source === 'yandere' ? 'https://files.yande.re/sample/' + id + '.jpg' : 'https://konachan.net/sample/' + id + '.jpg',
  })
  const download = async url => Buffer.from(url.endsWith('/3.jpg') || url.endsWith('/5.jpg') ? 'scheduled' : url)
  const register = () => registerSearch(api, {
    imageDelivery: open(), download,
    search: (args, options) => searchKonachan(args, { ...options, fetchPosts: async url => {
      const ids = options.source === 'yandere' ? [1, 2, 3] : [5]
      return Response.json(url.searchParams.get('page') === '1' ? ids.map(id => post(options.source, id)) : [])
    } }),
  })
  register()
  const find = async (id, groupId, source = 'yande') => {
    await handler({ kind: 'group', chatId: 'group:' + groupId, groupId, userId: '11', messageId: id, text: source + '找图 rating:s' })
    await waitFor(() => replies.has(id))
    return replies.get(id)
  }
  assert.match(await find('a', '20000'), /\/post\/show\/2/)
  assert.match(await find('b', '21000'), /\/post\/show\/1/)

  const tick = startDailyArt(api, {
    source: 'yandere', imageDelivery: open(), now: () => Date.parse('2026-11-09T09:01:00+08:00'), download,
    select: async excluded => {
      assert.ok(excluded.has('yandere:1') && excluded.has('yandere:2'))
      return [{ key: 'yandere:3', url: 'https://files.yande.re/sample/3.jpg' }]
    },
  })
  const push = tick()
  await waitFor(() => sends.length === 3)
  assert.match(await find('c', '20000'), /尚未发送过/)
  finishSend({ message_id: 3 })
  await push
  register()
  assert.match(await find('d', '20000', 'konachan'), /已经在这个会话发过/)
  assert.equal(sends.length, 3)
})

test('requests retain original rating and sender through queueing, replay, selection and revocation', async () => {
  const cfg = { enabled: true, ownerQQ: '11', allow: { groups: ['20', '21'], private: ['22'] } }
  const settings = { allowPrivateWhitelistSearch: true }
  const replies = [], sends = [], queries = []
  let handler, resolveFirst
  const first = new Promise(resolve => { resolveFirst = resolve })
  registerSearch({
    config: () => cfg, settings: () => settings, log: {}, onDispose() {}, on(_event, fn) { handler = fn },
    ask: ({ text }) => text === '普通图' ? first : Promise.resolve('{"intent":"search","rating":"e","chatId":"private:other","count":1}'),
    reply: async (msg, text) => replies.push([msg.messageId, text]),
    core: { hub: { sendSegments: async (id, data, _note, opts) => {
      if (opts.isCurrent()) sends.push([id, Buffer.from(data[0].data.file.slice(9), 'base64').toString()])
      return { message_id: 1 }
    } } },
  }, {
    search: async ({ rating: [rating] }) => {
      queries.push(rating)
      return [{ url: rating, rating, score: 31, width: 10, height: 10, tags: [], post_url: 'https://yande.re/post/show/1' }]
    },
    download: async url => { if (url === 'q') cfg.allow.groups = []; return Buffer.from(url) },
  })
  const message = (messageId, text, userId = '11', groupId = '20') => ({ kind: 'group', chatId: `group:${groupId}`, groupId, userId, messageId, text })
  const safe = message('1', 'yande找图 普通图')
  assert.equal(await handler(safe), true)
  await handler(message('2', 'yande找图 rating:e 先列候选'))
  await handler(safe)
  resolveFirst('{"intent":"search","rating":"e","source":"konachan"}')
  await waitFor(() => replies.length === 2)
  assert.deepEqual(queries, ['s', 'e'])
  assert.deepEqual(sends, [['group:20', 's']])
  await handler(message('3', 'yande找图 rating:e 发第1张', '12'))
  await handler(message('4', 'yande找图 rating:e 发第1张', '11', '21'))
  await waitFor(() => replies.length === 4)
  assert.equal(sends.length, 1)
  await handler(message('5', 'yande找图 rating:e 发第1张'))
  await waitFor(() => replies.length === 5)
  assert.deepEqual(sends.at(-1), ['group:20', 'e'])
  await handler(message('6', 'yande找图 rating:q 横图'))
  await waitFor(() => cfg.allow.groups.length === 0)
  assert.equal(sends.length, 2)
  settings.allowPrivateWhitelistSearch = false
  assert.equal(await handler({ kind: 'private', chatId: 'private:22', userId: '22', messageId: '7', text: 'yande找图 横图' }), false)
})

test('owner searches multiple ratings in one request and selects only from the same rating set', async () => {
  const cfg = { enabled: true, ownerQQ: '11', allow: { private: ['11', '22'] } }
  const replies = new Map(), requests = [], prompts = [], sends = []
  let handler, revokeOnDownload = false
  registerSearch({
    config: () => cfg, settings: () => ({ allowPrivateWhitelistSearch: true }), log: {}, onDispose() {},
    on(_event, fn) { handler = fn },
    ask: async ({ text }) => { prompts.push(text); return '{"intent":"search","rating":["e"],"sort":"score","count":2}' },
    reply: async (msg, text) => replies.set(msg.messageId, text),
    core: { hub: { sendSegments: async (chatId, segments, _note, opts) => {
      assert.equal(opts.isCurrent(), true)
      sends.push([chatId, segments.map(segment => Buffer.from(segment.data.file.slice(9), 'base64').toString())])
      return { message_id: 1 }
    } } },
  }, {
    search: (args, options) => searchKonachan(args, { ...options, fetchPosts: async url => {
      requests.push(url.searchParams.get('tags'))
      if (url.searchParams.get('page') !== '1') return Response.json([])
      return Response.json(['e', 'q', 's'].map((rating, i) => ({
        id: i + 1, rating, score: 50 - i, width: 20, height: 10, sample_url: `https://files.yande.re/sample/${rating}.jpg`,
      })))
    } }),
    download: async url => {
      if (revokeOnDownload) { cfg.ownerQQ = '33'; revokeOnDownload = false }
      return Buffer.from(new URL(url).pathname)
    },
  })
  const send = async (messageId, text, userId = '11') => {
    assert.equal(await handler({ kind: 'private', chatId: `private:${userId}`, userId, messageId, text }), true)
    await waitFor(() => replies.has(messageId))
    return replies.get(messageId)
  }

  assert.match(await send('1', 'yande找图 rating:s,q 风景', '22'), /只有主人/)
  assert.match(await send('2', 'konachan找图 rating:s,q 风景'), /只支持 Safe/)
  assert.match(await send('3', 'yande找图 rating:s,,q 风景'), /格式无效/)
  assert.match(await send('4', 'yande找图 rating:s,x 风景'), /不支持/)
  assert.deepEqual(prompts, [])
  assert.deepEqual(requests, [])

  const preview = await send('5', 'yande找图 rating:s,q 先列候选')
  assert.match(preview, /1\. q · [\s\S]*2\. s · /)
  assert.doesNotMatch(preview, /\. e · /)
  assert.match(preview, /yande找图 rating:s,q 发第 1 张/)
  assert.deepEqual(prompts, [])
  assert.equal(requests[0], '-rating:e order:id_desc')
  assert.match(await send('6', 'yande找图 rating:q 发第1张'), /没有可发送的候选/)
  assert.match(await send('7', 'yande找图 发第1张'), /没有可发送的候选/)
  assert.deepEqual(sends, [])
  await send('8', 'yande找图 rating:q,s 发第1张')
  assert.deepEqual(sends, [['private:11', ['/sample/q.jpg']]])

  await send('9', 'yande找图 rating:s,q 风景')
  assert.deepEqual(sends.at(-1), ['private:11', ['/sample/q.jpg', '/sample/s.jpg']])
  await send('10', 'yande找图 rating:q，风景')
  assert.equal(prompts.at(-1), '风景')
  assert.deepEqual(sends.at(-1), ['private:11', ['/sample/q.jpg']])
  await send('11', 'yande找图 rating:s,q,e 风景')
  assert.deepEqual(sends.at(-1), ['private:11', ['/sample/e.jpg', '/sample/q.jpg']])

  const sentBeforeRevocation = sends.length
  revokeOnDownload = true
  assert.equal(await handler({ kind: 'private', chatId: 'private:11', userId: '11', messageId: '12', text: 'yande找图 rating:s,q 风景' }), true)
  await send('13', 'yande找图 风景')
  assert.equal(sends.length, sentBeforeRevocation + 1)
  assert.deepEqual(sends.at(-1), ['private:11', ['/sample/s.jpg']])
})

test('original QQ commands enforce e,q, optional score and a rolling seven-day window', async () => {
  const now = Math.floor(Date.now() / 1000)
  const week = 7 * 86400
  const cfg = { enabled: true, ownerQQ: '11', allow: { private: ['22'] } }
  const fixtures = [
    ['s', 90, now - 1],
    ['e', -4, now - week - 1],
    ['q', 29, undefined],
    ['q', 29, now + 3600],
    ['q', -2, now - week + 2],
    ['e', 30, now - 60],
  ]
  const posts = fixtures.map(([rating, score, created_at], i) => ({
    id: i + 1, rating, score, created_at, width: 1080, height: 1920, tags: 'wuthering_waves',
    sample_url: 'https://files.yande.re/sample/' + (i + 1) + '.jpg',
  }))
  const replies = new Map(), queries = [], sent = []
  let handler, onlySafe = false, plannerCalls = 0
  registerSearch({
    config: () => cfg, settings: () => ({ allowPrivateWhitelistSearch: true }), log: {}, onDispose() {},
    on(_event, fn) { handler = fn },
    ask: async () => { plannerCalls++; return '{"intent":"clarify"}' },
    reply: async (msg, text) => replies.set(msg.messageId, text),
    core: { hub: { sendSegments: async (_chat, segments) => {
      sent.push(...segments.map(segment => Buffer.from(segment.data.file.slice(9), 'base64').toString()))
      return { message_id: 1 }
    } } },
  }, {
    search: (args, options) => {
      queries.push(args)
      return searchKonachan(args, { ...options, fetchPosts: async url => {
        if (url.searchParams.get('page') !== '1') return Response.json([])
        return Response.json(onlySafe ? posts.slice(0, 1) : posts)
      } })
    },
    download: async url => Buffer.from(new URL(url).pathname),
  })
  async function send(text, userId = '11') {
    const messageId = String(replies.size + 1)
    assert.equal(await handler({ kind: 'private', chatId: 'private:' + userId, userId, messageId, text }), true)
    await waitFor(() => replies.has(messageId))
    return replies.get(messageId)
  }

  assert.match(await send('yande找图 鸣潮 rating评级e,q'), /1\. e · -4 分/)
  assert.match(await send('yande找图 鸣潮 rating评级e,q 30分以上'), /1\. e · 30 分/)
  assert.match(await send('yande找图 wuthering_waves rating:e,q 最近一周'), /1\. q · -2 分/)
  assert.deepEqual(sent, ['/sample/2.jpg', '/sample/6.jpg', '/sample/5.jpg'])
  for (const args of queries) {
    assert.deepEqual(args.rating, ['q', 'e'])
    assert.deepEqual(args.tags, ['wuthering_waves'])
  }
  assert.deepEqual(queries.map(args => args.min_score), [undefined, 30, undefined])
  assert.ok(Math.abs(queries[2].created_since - (now - week)) <= 2)
  assert.equal(plannerCalls, 0)

  const preview = await send('yande找图 鳴潮 不限rating 先列候选')
  assert.doesNotMatch(preview, /\d+\. s ·/)
  assert.match(preview, /yande找图 rating:q,e 发第 1 张/)
  assert.match(await send('yande找图 发第1张 无限制'), /1\. e · -4 分/)
  assert.match(await send('yande找图 鸣潮 无限制'), /1\. e · -4 分/)
  assert.match(await send('yande找图 鸣潮 不限rating', '22'), /只有主人/)
  assert.match(await send('yande找图 鸣潮 rating:e,,q'), /格式无效/)
  assert.match(await send('yande找图 鸣潮 rating:s rating:e,q'), /条件冲突/)
  assert.match(await send('yande找图 Wuthering Waves'), /1\. s · 90 分/)
  onlySafe = true
  const sentBefore = sent.length
  assert.match(await send('yande找图 鸣潮 rating:e,q'), /没有匹配作品/)
  assert.equal(sent.length, sentBefore)
})

test('filter-only monthly search sends one image and reconciles an ambiguous QQ group timeout', async () => {
  const cfg = { enabled: true, ownerQQ: '11', botQQ: '33', allow: { groups: ['20'] } }
  const now = Math.floor(Date.now() / 1000)
  const selected = Buffer.from('expected group image')
  const hash = createHash('md5').update(selected).digest('hex')
  const historyImage = { type: 'image', data: { file: hash.toUpperCase() + '.jpg' } }
  const replies = new Map(), requests = [], historyCalls = []
  let handler, sends = 0, historyContainsImage = true
  registerSearch({
    config: () => cfg, settings: () => ({}), log: {}, onDispose() {},
    on(_event, fn) { handler = fn },
    ask: async () => { throw Error('structured filters do not require a topic or model') },
    reply: async (msg, text) => replies.set(msg.messageId, text),
    onebot: async (action, args) => {
      historyCalls.push([action, args.group_id])
      const time = Math.floor(Date.now() / 1000)
      const messages = [
        { user_id: 33, group_id: 20, time: time - 120, message_id: 90, message: [historyImage] },
        { user_id: 44, group_id: 20, time, message_id: 91, message: [historyImage] },
        { user_id: 33, group_id: 21, time, message_id: 92, message: [historyImage] },
        { user_id: 33, group_id: 20, time, message_id: 93, message: [{ type: 'image', data: { file: 'different.jpg' } }] },
      ]
      if (historyContainsImage) messages.push({ sender: { user_id: 33 }, group_id: 20, time, message_id: 94, message: [historyImage] })
      return { messages }
    },
    core: { hub: { sendSegments: async (_chat, segments) => {
      sends++
      assert.deepEqual(Buffer.from(segments[0].data.file.slice(9), 'base64'), selected)
      throw Error('send_group_msg 失败：Timeout: NTEvent serviceAndMethod:NodeIKernelMsgService/sendMsg')
    } } },
  }, {
    search: (args, options) => searchKonachan(args, { ...options, fetchPosts: async url => {
      requests.push(url.searchParams.get('tags'))
      const post = (id, rating, score, age) => ({
        id, rating, score, created_at: now - age * 86400, width: 1080, height: 1920,
        sample_url: 'https://files.yande.re/sample/' + id + '.jpg',
      })
      return Response.json([post(1, 's', 50, 1), post(2, 'e', 100, 31), post(3, 'e', 29, 1), post(4, 'e', 30, 20)])
    } }),
    download: async url => { assert.ok(url.endsWith('/4.jpg')); return selected },
  })
  const text = 'yande找图 最近一个月 rating:e 分数30以上'
  const send = messageId => handler({ kind: 'group', chatId: 'group:20', groupId: '20', userId: '11', messageId, text })
  await send('1')
  await waitFor(() => replies.has('1'))
  assert.match(replies.get('1'), /1\. e · 30 分/)
  assert.equal(sends, 1)
  assert.deepEqual(historyCalls, [['get_group_msg_history', 20]])
  assert.match(requests[0], /^rating:e score:30\.\./)

  historyContainsImage = false
  await send('2')
  for (let i = 0; !replies.has('2') && i < 100; i++) await delay(20)
  assert.match(replies.get('2'), /群历史里暂未确认/)
  assert.equal(sends, 2)
  assert.equal(historyCalls.length, 3)
})

test('a confirmed QQ risk-control rejection falls back to candidate links for downloaded e/q images', async () => {
  const cfg = { enabled: true, ownerQQ: '11', allow: { groups: ['20'] } }
  const replies = new Map()
  let handler, sends = 0, downloads = 0
  let sendError = Object.assign(new Error('send_group_msg 失败：1200'), { data: { wording: '图片发送被风控拦截' } })
  let downloadError
  registerSearch({
    config: () => cfg, settings: () => ({}), log: {}, onDispose() {},
    on(_event, fn) { handler = fn },
    ask: async () => { throw Error('explicit rating does not require planning') },
    reply: async (msg, text) => replies.set(msg.messageId, text),
    core: { hub: { sendSegments: async () => { sends++; throw sendError } } },
  }, {
    search: async ({ rating: [rating] }) => [{
      rating, score: 35, width: 100, height: 200, tags: ['wuthering_waves', 'lily_(wuthering_waves)'],
      url: 'https://files.yande.re/sample/123.jpg', post_url: 'https://yande.re/post/show/123',
    }],
    download: async () => { downloads++; if (downloadError) throw downloadError; return Buffer.from('downloaded image') },
  })
  const send = async (messageId, rating) => {
    await handler({ kind: 'group', chatId: 'group:20', groupId: '20', userId: '11', messageId, text: 'yande找图 rating:' + rating })
    await waitFor(() => replies.has(messageId))
    return replies.get(messageId)
  }
  for (const rating of ['e', 'q']) {
    const text = await send(rating, rating)
    assert.match(text, /QQ 风控拦截了图片/)
    assert.match(text, /wuthering_waves、lily_\(wuthering_waves\)/)
    assert.match(text, /https:\/\/yande\.re\/post\/show\/123/)
    assert.doesNotMatch(text, /files\.yande\.re|base64:/)
  }
  assert.equal(sends, 2)
  assert.equal(downloads, 2)
  assert.doesNotMatch(await send('safe', 's'), /作品链接/)
  sendError = new Error('send_group_msg 失败：1200')
  assert.doesNotMatch(await send('generic', 'e'), /作品链接/)
  downloadError = new Error('下载图片失败')
  assert.doesNotMatch(await send('download', 'q'), /作品链接/)
  assert.equal(sends, 4)
  assert.equal(downloads, 5)
})
