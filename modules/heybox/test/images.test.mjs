import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { HeyboxClient } from '../lib/api.mjs'

process.env.TZ = 'Asia/Shanghai'

// 1x1 PNG（真实可解析的文件头，用来验证尺寸解析和上传参数）
const PNG_1x1 = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64')

/** 造一个能发帖的 fixture：捕获上传参数与正文，图片走内存里的假实现 */
async function postFixture({ imagegen, images = [], text = '', emptyMemePacks = false } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'heybox-post-'))
  // site.mjs 在模块加载时就把 HOME 定死了（生图落盘走 HOME/.dsh/heybox-imgs），
  // 所以必须先把 USERPROFILE 指向临时目录，再动态 import —— 静态 import 会提到上面先执行。
  process.env.USERPROFILE = dir
  const cfg = {
    enabled: true, dryRun: false, ownerQQ: '12345678', speakUp: { awakeFrom: 0, awakeTo: 24 },
    heybox: {
      enabled: true, cookie: 'pkey=abc; heybox_id=1', maxPostsPerDay: 9, postStyle: 'diary',
      // 后面的用例要发 450~900 字，这里把字数区间放宽，免得撞上风格自带的上限
      postWordsMin: 100, postWordsMax: 3000,
      dailyPosts: [], defaultTopic: 7214,
    },
  }
  const stateFile = join(dir, 'state.json')
  writeFileSync(stateFile, JSON.stringify({
    quota: { date: new Date().toISOString().slice(0, 10), like: 0, comment: 0, post: 0, browse: 0, share: 0 },
    acts: { date: new Date().toISOString().slice(0, 10), fetchedAt: 1, list: [], plain: [] },
  }))

  // CI 里没有用户的 ~/.dsh/meme-packs，兜底路径必须有图可挑，否则这些用例会假失败。
  // 这里在临时目录造一个最小图库，并把它注入给模块。
  // emptyMemePacks=true：把图库根指到一个空目录，模拟「这台机器没装表情包」，
  // 用来测「图库里没有可挑的图才现画」。注意不能只是「不建目录」——
  // 下面的写法仍会往 packDir 里写图，那样库其实是有图的。
  const memeRoot = emptyMemePacks ? join(dir, 'no-packs') : join(dir, 'meme-packs')
  const packDir = join(memeRoot, 'dafeiyu-learned', 'memes', 'daily')
  if (!emptyMemePacks) {
    mkdirSync(packDir, { recursive: true })
    for (let i = 0; i < 8; i++) writeFileSync(join(packDir, 'm' + i + '.png'), PNG_1x1)
  }

  const uploads = []
  let posted = null
  const client = {
    riskInfo: () => ({ level: 0, until: 0, leftMs: 0 }),
    riskToken: () => 't',
    dispose: () => {},
    get: async () => ({ status: 'ok', result: { link: { hashtags: [], content_tags: [] } } }),
    post: async (path, body) => {
      if (String(path).includes('upload/info')) {
        uploads.push(JSON.parse(body.file_infos))
        return { status: 'ok', result: { keys: ['k/1.png'], bucket: 'b', region: 'r' } }
      }
      if (String(path).includes('upload/token')) return { status: 'ok', result: { credentials: { tmpSecretId: 'i', tmpSecretKey: 'k', sessionToken: 't' } } }
      if (String(path).includes('upload/callback')) return { status: 'ok', result: { preview_urls: ['https://cdn.example/x.png'] } }
      if (String(path).includes('/link/post')) { posted = body; return { status: 'ok', result: { link_id: '1' } } }
      return { status: 'ok', result: {} }
    },
    putCOS: async () => true,
  }

  const hb = (await import('../lib/site.mjs')).createHeybox({
    getConfig: () => cfg, setCookie: () => {}, hub: {}, memory: {}, log: { info: () => {}, warn: () => {} },
    stateFile, credFile: join(dir, 'missing.json'),
    clientFactory: () => client,
    imagegen: imagegen === undefined ? null : imagegen,
    memeRoot,
  })

  return {
    hb, cfg, uploads, get posted() { return posted }, dir,
    close() { hb.dispose && hb.dispose(); rmSync(dir, { recursive: true, force: true }) },
  }
}

test('配图张数按字数分档：≤500 文末 1 张', async (t) => {
  const f = await postFixture({})
  t.after(() => f.close())
  const plan = await f.hb.planImages('一二三四五'.repeat(90), {})
  assert.equal(plan.slots.length, 1)
  assert.deepEqual(plan.slots.map((s) => s.kind), ['tail'])
})

test('配图张数按字数分档：500-1000 首段后 + 文末', async (t) => {
  const f = await postFixture({})
  t.after(() => f.close())
  const plan = await f.hb.planImages('一二三四五'.repeat(150), {})
  assert.equal(plan.slots.length, 2)
  assert.deepEqual(plan.slots.map((s) => s.kind).sort(), ['intro', 'tail'])
})

test('配图张数按字数分档：1000 字以上每多 1000 字文中再加一张', async (t) => {
  const f = await postFixture({})
  t.after(() => f.close())
  const two = await f.hb.planImages('一二三四五'.repeat(400), {})   // 2000 字
  assert.equal(two.slots.length, 3)
  assert.ok(two.slots.some((s) => s.kind === 'inline'))
  const three = await f.hb.planImages('一二三四五'.repeat(600), {})  // 3000 字
  assert.equal(three.slots.length, 4)
})

test('表情包优先：图库里有图就先用图，不白调生图', async (t) => {
  // 主人定的顺序：表情包优先，图库里没有匹配的才现画。
  // 旧版是反过来的（生图优先），好处是省成本、也更贴她的人设调性。
  let calls = 0
  const gen = { enabled: async () => true, generate: async () => { calls++; return PNG_1x1 } }
  const f = await postFixture({ imagegen: gen })
  t.after(() => f.close())
  const plan = await f.hb.planImages('一二三四五'.repeat(150), { mood: '开心' })
  assert.equal(plan.slots.length, 2, '要两张图')
  assert.equal(plan.fallback, 2, '两张都来自表情包')
  assert.equal(plan.generated, 0, '一张都不用现画')
  assert.equal(calls, 0, '有图时不该调用生图模型')
  assert.deepEqual(plan.slots.map((s) => s.from), ['meme', 'meme'], '来源要标成 meme')
})

test('图库里没有图时才调生图模型', async (t) => {
  let calls = 0
  const gen = { enabled: async () => true, generate: async () => { calls++; return PNG_1x1 } }
  // memeRoot 指到空目录 = 这台机器没装表情包
  const f = await postFixture({ imagegen: gen, emptyMemePacks: true })
  t.after(() => f.close())
  const plan = await f.hb.planImages('一二三四五'.repeat(150), { mood: '开心' })
  assert.equal(plan.slots.length, 2)
  assert.equal(plan.generated, 2, '没图可挑就现画')
  assert.equal(plan.fallback, 0)
  assert.equal(calls, 2)
  assert.deepEqual(plan.slots.map((s) => s.from), ['generated', 'generated'])
})

test('生图坏掉时用表情包库兜底，且同帖不重复', async (t) => {
  const gen = { enabled: async () => true, generate: async () => { throw new Error('生图服务没响应') } }
  const f = await postFixture({ imagegen: gen })
  t.after(() => f.close())
  const plan = await f.hb.planImages('一二三四五'.repeat(150), {})
  assert.equal(plan.slots.length, 2)
  assert.equal(plan.generated, 0)
  assert.ok(plan.fallback >= 1)
  const paths = plan.slots.map((s) => s.path)
  assert.equal(new Set(paths).size, paths.length, '同一帖里的兜底图不能重复')
})

test('生图模块没开时直接兜底', async (t) => {
  const gen = { enabled: async () => false, generate: async () => PNG_1x1 }
  const f = await postFixture({ imagegen: gen })
  t.after(() => f.close())
  const plan = await f.hb.planImages('一二三四五'.repeat(90), {})
  assert.equal(plan.generated, 0)
  assert.equal(plan.slots.length, 1)
})

test('上传图片按真实宽高上报，不再写死 1000x600', async (t) => {
  const f = await postFixture({})
  t.after(() => f.close())
  // 用 1x1 的 png 走一次真实上传流程
  const dir = join(f.dir, 'img.png')
  writeFileSync(dir, PNG_1x1)
  const r = await f.hb.post({ title: '尺寸', text: '一二三四五'.repeat(90), imagesByPos: { tail: [dir] } })
  assert.equal(r.ok, true)
  assert.equal(f.uploads.length, 1)
  assert.equal(f.uploads[0][0].width, 1)
  assert.equal(f.uploads[0][0].height, 1)
  // 正文里的 data-width/height 也要是真实值
  const html = JSON.parse(f.posted.text)[0].text
  assert.match(html, /data-width="1"/)
  assert.match(html, /data-height="1"/)
})

test('话题以纯文本名字数组提交，而不是对象', async (t) => {
  const f = await postFixture({})
  t.after(() => f.close())
  const dir = join(f.dir, 'img.png')
  writeFileSync(dir, PNG_1x1)
  const r = await f.hb.post({ title: '话题', text: '一二三四五'.repeat(90), imagesByPos: { tail: [dir] }, hashtags: ['盒友日常'] })
  assert.equal(r.ok, true)
  const sent = JSON.parse(f.posted.hashtags)
  assert.ok(Array.isArray(sent), 'hashtags 要是数组')
  assert.ok(sent.every((x) => typeof x === 'string'), '每一项都必须是纯文本名字，不能是对象')
})

test('一张图都没传上去时拒发，避免出现纯文字帖', async (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'heybox-imgfail-'))
  const cfg = { enabled: true, dryRun: false, heybox: { enabled: true, cookie: 'pkey=abc', maxPostsPerDay: 9, dailyPosts: [] } }
  const stateFile = join(dir, 'state.json')
  writeFileSync(stateFile, JSON.stringify({ quota: { date: new Date().toISOString().slice(0, 10), post: 0 }, acts: { date: new Date().toISOString().slice(0, 10), list: [], plain: [] } }))
  const client = {
    riskInfo: () => ({ level: 0, until: 0, leftMs: 0 }), riskToken: () => 't',
    dispose: () => {},
    get: async () => ({ status: 'ok', result: {} }),
    // 上传第一步就失败，模拟图传不上去
    post: async (path) => (String(path).includes('upload/info') ? { status: 'ok', result: { keys: [] } } : { status: 'ok', result: {} }),
    putCOS: async () => true,
  }
  const img = join(dir, 'img.png')
  writeFileSync(img, PNG_1x1)
  const hb = (await import('../lib/site.mjs')).createHeybox({ getConfig: () => cfg, setCookie: () => {}, hub: {}, memory: {}, log: { info: () => {}, warn: () => {} }, stateFile, credFile: join(dir, 'x.json'), clientFactory: () => client })
  const r = await hb.post({ title: '无图', text: '一二三四五'.repeat(90), imagesByPos: { tail: [img] } })
  assert.equal(r.ok, false)
  assert.equal(r.code, 'image_upload_failed')
  rmSync(dir, { recursive: true, force: true })
})

test('没给配图且没给 imagesByPos 时自动配图', async (t) => {
  let calls = 0
  const gen = { enabled: async () => true, generate: async () => { calls++; return PNG_1x1 } }
  const f = await postFixture({ imagegen: gen })
  t.after(() => f.close())
  const r = await f.hb.post({ title: '自动', text: '一二三四五'.repeat(150) })
  assert.equal(r.ok, true)
  assert.equal(r.autoImages.planned, 2, '按字数规划出 2 张')
  // 顺序是「表情包优先」：fixture 里有图库，所以两张都该来自表情包，生图不该被调用
  assert.equal(r.autoImages.fallback, 2)
  assert.equal(r.autoImages.generated, 0)
  assert.deepEqual(r.autoImages.sources, ['meme', 'meme'])
  assert.equal(calls, 0)
})
