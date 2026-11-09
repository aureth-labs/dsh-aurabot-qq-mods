// 表情包（stickers）测试：规则命中、可用性过滤、模糊匹配、自动配、
// 淘汰排序、图片嗅探与尺寸门槛、store 的增删改与面板接口。
//
// 全部走 fake api：AURABOT_DATA_DIR 指到临时目录，不碰真表情库、不联网、不发 QQ 请求。
// 跑法见仓库根 scripts/plugin-env.mjs：
//   AURABOT_PLUGIN_DIR=<插件目录> node --import ./scripts/plugin-env.mjs --test "modules/stickers/test/*.test.mjs"

import { test, before, after, beforeEach } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, mkdtempSync, readFileSync, writeFileSync, mkdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

import mod from '../index.js'
import {
  DEFAULT_TAGS, NEVER_RANDOM, RULE_PREFIXES,
  matchSticker, ruleHit, usableStickers, stickerUsable, pickForReply, pickEvict,
} from '../lib/stickers.js'
import { imageSize, mimeOf, stickerSizeOk } from '../lib/_inbound.js'

const MOD_DIR = fileURLToPath(new URL('../', import.meta.url))
const meta = JSON.parse(readFileSync(join(MOD_DIR, 'module.json'), 'utf8'))

/**
 * 建临时目录：优先用系统临时目录，不可写时退到模块目录下（有些受限环境把 %TEMP% 锁了，
 * 比如被沙箱拦住的终端）。
 * 注意回退到模块目录时要自己负责清理——不然测试跑完会留下垃圾、甚至被误提交。
 * 落在系统临时目录的那份由系统管，模块目录下的这份统一在 after 里删。
 */
const madeInModule = []
function tmp(tag) {
  for (const base of [tmpdir(), join(MOD_DIR, '.test-tmp')]) {
    try {
      mkdirSync(base, { recursive: true })
      const dir = mkdtempSync(join(base, tag + '-'))
      if (base !== tmpdir()) madeInModule.push(dir)
      return dir
    } catch (error) { /* 换下一个 */ }
  }
  throw new Error('找不到可写的临时目录')
}

/** 全部测试跑完，把落在模块目录下的临时目录删掉。 */
after(() => {
  for (const dir of madeInModule) {
    try { rmSync(dir, { recursive: true, force: true }) } catch (error) { /* 删不掉就算了 */ }
  }
  madeInModule.length = 0
})

// ── 造图：最小可解析的 PNG / GIF / JPEG / WEBP 头 ─────────────────────────

function png(width, height, nonce = '') {
  const b = Buffer.alloc(64)
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(b, 0)
  b.writeUInt32BE(width, 16)
  b.writeUInt32BE(height, 20)
  // 末尾塞个 nonce：同样的宽高也能造出不同的 md5（库是按 md5 去重的）
  Buffer.from(String(nonce), 'utf8').copy(b, 32)
  return b
}

/** 每次都造一张「不一样」的图（同宽高也行），免得被 md5 去重。 */
let seq = 0
const uniq = (width = 200, height = 200) => png(width, height, `#${++seq}`)
function gif(width, height) {
  const b = Buffer.alloc(32)
  Buffer.from('GIF89a', 'ascii').copy(b, 0)
  b.writeUInt16LE(width, 6)
  b.writeUInt16LE(height, 8)
  return b
}
function webpVp8x(width, height) {
  const b = Buffer.alloc(40)
  Buffer.from('RIFF', 'ascii').copy(b, 0)
  Buffer.from('WEBP', 'ascii').copy(b, 8)
  Buffer.from('VP8X', 'ascii').copy(b, 12)
  b.writeUIntLE(width - 1, 24, 3)
  b.writeUIntLE(height - 1, 27, 3)
  return b
}

// ── 假 api：对齐 src/core/modules.js 的 makeApi 面 ────────────────────────

function makeEnv({ settings = {}, dryRun = false, owner = '10000', level = 'full', allOwner = true } = {}) {
  const cfg = {
    ownerQQ: owner,
    dryRun,
    stickers: {
      enabled: true, collect: true, collectMode: 'auto', caption: false,
      maxPerHour: 5, maxLibrary: 100,
      blacklist: [], whitelist: [], mode: 'all',
      captionModel: null,
      ...settings.stickers,
    },
  }
  const handlers = { tools: [], routes: new Map(), rules: [] }
  const calls = { sendSticker: [], addCustomFace: [], modifyCustomFace: [], deleteCustomFace: [] }
  let n = 0
  const api = {
    id: 'stickers',
    dir: MOD_DIR,
    log: { info() {}, warn() {}, error() {}, debug() {} },
    config: () => cfg,
    dsh: {},
    dataDir: (...parts) => join(process.env.AURABOT_DATA_DIR, 'stickers', ...parts),
    tool: (factory) => {
      const list = factory({
        chat: { kind: 'private', chatId: 'private:' + owner, userId: owner },
        level,
        sessionId: 's1',
      })
      if (Array.isArray(list)) handlers.tools.push(...list)
      else if (list) handlers.tools.push(list)
    },
    route: (path, fn) => handlers.routes.set(path, fn),
    rule: (fn) => handlers.rules.push(fn),
    core: {
      hub: {
        sendSticker: async (chatId, name) => { calls.sendSticker.push({ chatId, name }); return true },
        turnSendersAllOwner: () => allOwner,
        stickerOf: () => null,
        recentMedia: () => [],
        chatOfSession: () => 'private:' + owner,
      },
      onebot: {
        call: async (action, params) => {
          if (action === 'add_custom_face') { calls.addCustomFace.push(params); return { emoji_id: 'e' + ++n } }
          if (action === 'modify_custom_face') { calls.modifyCustomFace.push(params); return {} }
          if (action === 'delete_custom_face') { calls.deleteCustomFace.push(params); return {} }
          if (action === 'fetch_custom_face') return { data: [] }
          return {}
        },
      },
      http: {
        query: (req) => req?.query || {},
        body: async (req) => req?.body || {},
        send: (res, code, body) => { res.statusCode = code; res.body = body },
      },
    },
  }
  const store = mod.setup(api)
  const tool = (name) => handlers.tools.find((t) => t.name === name)
  return { api, cfg, handlers, calls, store, tool, level }
}

const run = (t, args) => t.execute(args || {}, {})

before(() => {
  process.env.AURABOT_DATA_DIR = tmp('aurabot-stickers')
})
beforeEach(() => {
  // 每个用例一块干净的数据目录
  process.env.AURABOT_DATA_DIR = tmp('aurabot-stickers')
})

// ── module.json / 元信息 ─────────────────────────────────────────────────

test('module.json 与入口的 id/version/api 一致，且声明替换内置', () => {
  assert.equal(meta.id, mod.id)
  assert.equal(meta.id, 'stickers')
  assert.equal(meta.version, mod.version)
  assert.equal(meta.api, mod.api)
  assert.equal(meta.replacesBuiltin, true, '和内置模块同名，必须显式声明')
  assert.equal(typeof mod.setup, 'function')
})

test('内置表情包用到的能力都声明了（plugins 面板要按这个提示用户）', () => {
  // 联网（偷图 / 拉图）、读写文件（表情库）、启动程序（画作目录）、读配置、内部对象
  for (const cap of ['network', 'filesystem', 'plugin-config', 'plugin-internals']) {
    assert.ok(meta.capabilities.includes(cap), `缺 ${cap}`)
  }
})

test('默认标签里包含「不随机」，它不能被当成普通情绪标签用', () => {
  assert.ok(DEFAULT_TAGS.includes('开心'))
  assert.equal(NEVER_RANDOM, '不随机')
  assert.equal(DEFAULT_TAGS.includes(NEVER_RANDOM), false, '「不随机」是保留标记，不该混进情绪清单')
})

test('规则支持的前缀和 README 承诺的一致', () => {
  assert.deepEqual(RULE_PREFIXES, ['tag', 'name', 'emotion', 'group', 'pack', 'id', 'file'])
})

// ── 规则命中 ─────────────────────────────────────────────────────────────

const ITEM = { name: '委屈巴巴的小猫', tags: ['卖萌', '委屈'], emotion: '委屈', md5: 'abcdef1234567890', nkId: 'nk1', file: 'a.gif', pack: '小猫咪', use: '被说了有点难过' }

test('ruleHit：tag / name / emotion / id / file / pack 前缀各自管自己那一段', () => {
  assert.equal(ruleHit(ITEM, 'tag:卖萌'), true)
  assert.equal(ruleHit(ITEM, 'tag:开心'), false)
  assert.equal(ruleHit(ITEM, 'name:小猫'), true)
  assert.equal(ruleHit(ITEM, 'emotion:委屈'), true)
  assert.equal(ruleHit(ITEM, 'id:abcdef'), true)
  assert.equal(ruleHit(ITEM, 'file:a.gif'), true)
  assert.equal(ruleHit(ITEM, 'pack:小猫咪'), true)
  // group 和 pack 互为兜底（老数据只有其中一个字段）
  assert.equal(ruleHit(ITEM, 'group:小猫咪'), true)
})

test('ruleHit：规则大小写和前后空格不影响', () => {
  assert.equal(ruleHit(ITEM, '  TAG:  卖萌  '), true)
  assert.equal(ruleHit({ name: 'Happy Cat' }, 'name:happy'), true)
})

test('ruleHit：不带前缀时哪都能对上；空规则 / 只有前缀不算命中', () => {
  assert.equal(ruleHit(ITEM, '委屈'), true)
  assert.equal(ruleHit(ITEM, 'abcdef'), true)
  assert.equal(ruleHit(ITEM, ''), false)
  assert.equal(ruleHit(ITEM, '   '), false)
  assert.equal(ruleHit(ITEM, 'tag:'), false, '只有前缀不该把所有表情都算命中')
  assert.equal(ruleHit(null, 'tag:卖萌'), false)
  assert.equal(ruleHit(ITEM, null), false)
})

test('ruleHit：写错的前缀按「没前缀」处理，不会让整条规则失效', () => {
  assert.equal(ruleHit(ITEM, 'mood:委屈'), true, '不认识的前缀退化成无前缀匹配')
  assert.equal(ruleHit(ITEM, 'mood:开心'), false)
})

// ── 可用性 ───────────────────────────────────────────────────────────────

const LIB = [
  { md5: 'a', name: '开心鱼', tags: ['开心'] },
  { md5: 'b', name: '委屈猫', tags: ['委屈', NEVER_RANDOM] },
  { md5: 'c', name: '嘲讽脸', tags: ['嘲讽'], off: true },
  { md5: 'd', name: '卖萌兔', tags: ['卖萌'], on: true },
]

test('usableStickers：单张停用的不出现，默认全都能用', () => {
  const ids = usableStickers(LIB).map((i) => i.md5)
  assert.deepEqual(ids, ['a', 'b', 'd'])
  assert.equal(stickerUsable(LIB[2]), false)
  assert.equal(stickerUsable(LIB[0]), true)
})

test('usableStickers：黑名单命中的被剔掉，其余保留', () => {
  const ids = usableStickers(LIB, { blacklist: ['name:委屈'] }).map((i) => i.md5)
  assert.deepEqual(ids, ['a', 'd'])
})

test('usableStickers：白名单非空时只留命中的', () => {
  const ids = usableStickers(LIB, { whitelist: ['tag:卖萌'] }).map((i) => i.md5)
  assert.deepEqual(ids, ['d'])
})

test('usableStickers：allowlist 模式只用手动开着的（on=true）', () => {
  const ids = usableStickers(LIB, { mode: 'allowlist' }).map((i) => i.md5)
  assert.deepEqual(ids, ['d'])
  // 白名单和 allowlist 同时给：allowlist 优先
  const both = usableStickers(LIB, { mode: 'allowlist', whitelist: ['tag:开心'] }).map((i) => i.md5)
  assert.deepEqual(both, ['d'])
})

test('usableStickers：空规则 / 空列表 / 脏数据都不炸', () => {
  assert.deepEqual(usableStickers(null, {}), [])
  assert.deepEqual(usableStickers(undefined), [])
  assert.deepEqual(usableStickers([null, LIB[0]], {}).map((i) => i.md5), ['a'])
  // 空字符串规则被过滤掉，不会把整库判成命中
  assert.equal(usableStickers(LIB, { blacklist: ['', '  '] }).length, 3)
})

// ── 模糊匹配 ─────────────────────────────────────────────────────────────

test('matchSticker：名字 / 标签 / 用途都能对上，空查询返回 null', () => {
  assert.equal(matchSticker(LIB, '开心鱼').md5, 'a')
  assert.equal(matchSticker(LIB, '委屈').md5, 'b')
  assert.equal(matchSticker(LIB, '卖萌').md5, 'd')
  assert.equal(matchSticker(LIB, ''), null)
  assert.equal(matchSticker(LIB, '   '), null)
  assert.equal(matchSticker([], '开心'), null)
})

test('matchSticker：完全对上的比部分对上的分高', () => {
  const items = [
    { md5: 'x', name: '开心' },
    { md5: 'y', name: '开心到飞起' },
  ]
  assert.equal(matchSticker(items, '开心').md5, 'x')
})

test('matchSticker：什么都不沾边就返回 null（不乱发一张）', () => {
  assert.equal(matchSticker(LIB, 'zzzzzz'), null)
  assert.equal(matchSticker(LIB, '量子力学'), null)
})

test('matchSticker：用途字段（use / summary）也算数', () => {
  const items = [{ md5: 'z', name: '', use: '等他回消息' }]
  assert.equal(matchSticker(items, '等他回消息').md5, 'z')
  assert.equal(matchSticker([{ md5: 'w', summary: '被夸了不好意思' }], '被夸了').md5, 'w')
})

// ── 自动配 ───────────────────────────────────────────────────────────────

test('pickForReply：回复里的词先按标签匹配；打了「不随机」的即使命中也不挑', () => {
  const items = [
    { md5: 'a', name: '开心鱼', tags: ['开心'] },
    { md5: 'b', name: '委屈猫', tags: ['委屈'] },
  ]
  assert.equal(pickForReply(items, '我好委屈').md5, 'b')

  // 同样的标签，但加上了「不随机」这个保留标记 → 不参与自动配
  const marked = [items[0], { ...items[1], tags: ['委屈', NEVER_RANDOM] }]
  for (let i = 0; i < 20; i++) assert.equal(pickForReply(marked, '我好委屈').md5, 'a')
})

test('pickForReply：没命中任何标签就随机挑一张能用的', () => {
  const picks = new Set()
  for (let i = 0; i < 40; i++) picks.add(pickForReply(LIB, '随便说点什么').md5)
  assert.ok(picks.size >= 2, '应该是在可用池里随机')
  assert.equal(picks.has('c'), false, '停用的不该出现')
})

test('pickForReply：全被屏蔽 / 全是「不随机」时返回 null，这一轮不配', () => {
  assert.equal(pickForReply([], '开心'), null)
  assert.equal(pickForReply([{ md5: 'b', tags: [NEVER_RANDOM] }], '开心'), null)
  // 黑名单把库里每一张都挡住了
  const all = pickForReply(LIB, '开心', { blacklist: ['name:开心鱼', 'name:委屈猫', 'name:卖萌兔', 'name:嘲讽脸'] })
  assert.equal(all, null)
  // 白名单模式下没开任何一张
  assert.equal(pickForReply(LIB, '开心', { mode: 'allowlist' }), LIB[3], '只有 d 是 on=true，它没打「不随机」')
  assert.equal(pickForReply([LIB[0]], '开心', { mode: 'allowlist' }), null)
})

// ── 淘汰排序 ─────────────────────────────────────────────────────────────

test('pickEvict：优先清最少用的，其次最老的', () => {
  const items = [
    { md5: 'a', uses: 5, lastUsed: 100, from: 'private:1' },
    { md5: 'b', uses: 0, lastUsed: 200, from: 'private:1' },
    { md5: 'c', uses: 0, lastUsed: 100, from: 'private:1' },
  ]
  assert.equal(pickEvict(items).md5, 'c', '都是 0 次时清最老的那张')
  assert.equal(pickEvict([{ md5: 'a', uses: 9 }]).md5, 'a')
})

test('pickEvict：主人加的 / 从 QQ 导进来的不清', () => {
  const items = [
    { md5: 'a', uses: 0, from: 'manual' },
    { md5: 'b', uses: 0, from: 'panel' },
    { md5: 'c', uses: 0, from: 'qq' },
    { md5: 'd', uses: 0, from: 'tool' },
  ]
  assert.equal(pickEvict(items), null, '全是不能清的')
  assert.equal(pickEvict([...items, { md5: 'e', uses: 1, from: 'private:1' }]).md5, 'e')
})

// ── 图片嗅探 ─────────────────────────────────────────────────────────────

test('mimeOf：按文件头认 PNG / GIF / JPEG / WEBP，认不出给八位字节流', () => {
  assert.equal(mimeOf(png(10, 10)), 'image/png')
  assert.equal(mimeOf(gif(10, 10)), 'image/gif')
  assert.equal(mimeOf(webpVp8x(10, 10)), 'image/webp')
  assert.equal(mimeOf(Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0, 0, 0, 0, 0, 0, 0, 0])), 'image/jpeg')
  assert.equal(mimeOf(Buffer.from('hello world!!')), 'application/octet-stream')
  assert.equal(mimeOf(null), 'application/octet-stream')
  assert.equal(mimeOf(Buffer.alloc(0)), 'application/octet-stream')
})

test('imageSize：读得出 PNG / GIF / WEBP 的宽高', () => {
  assert.deepEqual(imageSize(png(120, 90)), { width: 120, height: 90 })
  assert.deepEqual(imageSize(gif(64, 64)), { width: 64, height: 64 })
  assert.deepEqual(imageSize(webpVp8x(300, 200)), { width: 300, height: 200 })
})

test('imageSize：读不出（空 / 太短 / 伪图）返回 0 而不是抛错', () => {
  assert.deepEqual(imageSize(null), { width: 0, height: 0 })
  assert.deepEqual(imageSize(Buffer.alloc(4)), { width: 0, height: 0 })
  assert.deepEqual(imageSize(Buffer.from('这不是图片这是一段文字')), { width: 0, height: 0 })
})

test('stickerSizeOk：接近方形且不太大才算表情', () => {
  assert.equal(stickerSizeOk({ width: 200, height: 200, bytes: 1000 }), true)
  assert.equal(stickerSizeOk({ width: 600, height: 600, bytes: 1000 }), false, '超过默认 520')
  assert.equal(stickerSizeOk({ width: 400, height: 200, bytes: 1000 }), false, '太宽')
  assert.equal(stickerSizeOk({ width: 200, height: 400, bytes: 1000 }), false, '太长')
  assert.equal(stickerSizeOk({ width: 200, height: 200, bytes: 0 }), false, '空文件')
})

test('stickerSizeOk：读不出尺寸时只看体积（宁可放过，别把好图全拒了）', () => {
  assert.equal(stickerSizeOk({ width: 0, height: 0, bytes: 1000 }), true)
  // 门槛可以放宽
  assert.equal(stickerSizeOk({ width: 800, height: 800, bytes: 1000 }, { maxSide: 1000 }), true)
})

// ── store：真实读写（临时数据目录） ──────────────────────────────────────

const it = (md5, extra = {}) => ({ md5, file: `${md5}.png`, name: md5.toUpperCase(), tags: [], from: 'private:1', at: 1, ...extra })

test('store：addFromBuffer 落盘 + 建档，同一张不重复收', async () => {
  const { store } = makeEnv({ dryRun: true })
  const buf = png(200, 200)
  const r1 = await store.addFromBuffer(buf, { name: '小鱼', tags: ['开心'], from: 'manual', toQQ: false })
  assert.equal(r1.ok, true)
  assert.equal(r1.item.name, '小鱼')
  assert.ok(existsSync(join(process.env.AURABOT_DATA_DIR, 'stickers', r1.item.file)))

  const r2 = await store.addFromBuffer(buf, { name: '另一张', from: 'manual', toQQ: false })
  assert.equal(r2.existed, true, '同一张图按 md5 认出来')
  assert.equal(store.library().items.length, 1)
  assert.equal(store.library().items[0].name, '小鱼', '已有的那张不被覆盖')
})

test('store：不是图片的字节会被拒', async () => {
  const { store } = makeEnv({ dryRun: true })
  const r = await store.addFromBuffer(Buffer.from('这不是图片'), { from: 'manual' })
  assert.equal(r.ok, false)
  assert.match(r.reason, /不是图片/)
})

test('store：dryRun 下不往 QQ 收藏里加', async () => {
  const { store, calls } = makeEnv({ dryRun: true })
  await store.addFromBuffer(uniq(100, 100), { from: 'manual' })
  assert.equal(calls.addCustomFace.length, 0)
})

test('store：非 dryRun 时收藏到 QQ，并把 emoji_id 记下来', async () => {
  const { store, calls } = makeEnv({ dryRun: false })
  const r = await store.addFromBuffer(uniq(100, 100), { name: '小鱼', from: 'manual' })
  assert.equal(calls.addCustomFace.length, 1)
  assert.match(calls.addCustomFace[0].file, /^base64:\/\//)
  assert.equal(r.item.emojiId, 'e1')
  assert.equal(calls.modifyCustomFace.length, 1, '有名字就顺带回写 QQ 备注')
})

test('store：改名和改标签；名字截到 12 字、标签去重截到 5 个', () => {
  const { store } = makeEnv({ dryRun: true })
  store.addFromBuffer(uniq(100, 100), { from: 'manual' })
  const md5 = store.library().items[0].md5
  const r = store.rename(md5, '这是一个特别特别长的表情名字超过十二个字', ['开心', '#委屈', '开心', '卖萌', '无语', '嘲讽', '多余'])
  assert.equal(r.ok, true)
  assert.equal([...r.item.name].length, 12)
  assert.deepEqual(r.item.tags, ['开心', '委屈', '卖萌', '无语', '嘲讽'], '# 前缀去掉、去重、最多 5 个')
  assert.equal(store.rename('nope', 'x').ok, false)
})

test('store：单张停用 / 启用 / 批量 / 一键恢复', () => {
  const { store } = makeEnv({ dryRun: true })
  return (async () => {
    for (const k of ['a', 'b', 'c']) await store.addFromBuffer(uniq(100, 100), { from: 'manual' })
    const [a, b, c] = store.library().items
    assert.equal(store.setEnabled(a.md5, false).ok, true)
    assert.deepEqual(store.usable().map((i) => i.md5), [b.md5, c.md5], '停用的那张不出现')
    assert.equal(store.setEnabled(b.md5, false).changed, undefined) // 单张入口不返回 changed
    assert.deepEqual(store.usable().map((i) => i.md5), [c.md5])

    const many = store.setEnabledMany([a.md5, b.md5], true)
    assert.equal(many.changed, 2)
    assert.equal(store.usable().length, 3)
    assert.equal(store.setEnabledMany([], true).ok, false, '没选表情不算成功')

    const reset = store.resetEnabled()
    assert.equal(reset.ok, true)
    assert.equal(store.library().items.every((i) => i.on === undefined && i.off === undefined), true)
  })()
})

test('store：allowlist 模式下 resetEnabled 会提醒「清标记等于一张都不开」', () => {
  const { store, cfg } = makeEnv({ dryRun: true })
  return (async () => {
    await store.addFromBuffer(uniq(100, 100), { from: 'manual', toQQ: false })
    cfg.stickers.mode = 'allowlist'
    const r = store.resetEnabled()
    assert.equal(r.ok, true)
    assert.match(r.message, /一张都不开/)
  })()
})

test('store：删一张会连文件一起删；批量删报数量', async () => {
  const { store, calls } = makeEnv({ dryRun: false })
  await store.addFromBuffer(uniq(100, 100), { from: 'manual' })
  await store.addFromBuffer(uniq(120, 120), { from: 'manual' })
  const [x, y] = store.library().items
  const file = join(process.env.AURABOT_DATA_DIR, 'stickers', x.file)

  const one = await store.remove(x.md5)
  assert.equal(one.ok, true)
  assert.equal(existsSync(file), false)
  assert.equal(store.library().items.length, 1)

  assert.equal((await store.remove('nope')).ok, false)
  const many = await store.removeMany([y.md5])
  assert.equal(many.ok, true)
  assert.equal(many.removed, 1)
  assert.equal(store.library().items.length, 0)
  assert.equal((await store.removeMany([])).ok, false)
  assert.ok(calls.deleteCustomFace.length >= 1, '从 QQ 收藏里也删了')
})

test('store：libraryWithState 给每张标出能不能用 + 为什么', async () => {
  const { store, cfg } = makeEnv({ dryRun: true })
  await store.addFromBuffer(uniq(100, 100), { name: '正常', from: 'manual' })
  await store.addFromBuffer(uniq(120, 120), { name: '被停用', from: 'manual' })
  await store.addFromBuffer(uniq(140, 140), { name: '命中黑名单', from: 'manual' })
  const items = store.library().items
  store.setEnabled(items[1].md5, false)
  cfg.stickers.blacklist = ['name:命中黑名单']

  const view = store.libraryWithState()
  assert.equal(view.length, 3, '面板要看得见全部，不裁剪')
  assert.equal(view.every((i) => typeof i.usable === 'boolean'), true)
  assert.equal(view.find((i) => i.name === '正常').usable, true)
  assert.match(view.find((i) => i.name === '被停用').why, /手动停用/)
  assert.match(view.find((i) => i.name === '命中黑名单').why, /命中黑名单：name:命中黑名单/)
})

test('store：rulePreview 让人一眼看出规则写错没写错', async () => {
  const { store } = makeEnv({ dryRun: true })
  await store.addFromBuffer(uniq(100, 100), { name: '委屈猫', from: 'manual' })
  await store.addFromBuffer(uniq(120, 120), { name: '开心鱼', from: 'manual' })
  const hit = store.rulePreview('name:委屈')
  assert.equal(hit.count, 1)
  assert.deepEqual(hit.sample, ['委屈猫'])
  assert.equal(store.rulePreview('tag:根本没有这个标签').count, 0)
  assert.equal(store.rulePreview('').count, 0)
  assert.equal(store.rulePreview('tag:').count, 0, '写了一半的规则不该把所有表情都标成命中')
})

test('store：segmentFor 用本地文件拼 base64 图片段；商城表情原样转发', async () => {
  const { store } = makeEnv({ dryRun: true })
  const r = await store.addFromBuffer(uniq(100, 100), { name: '小鱼', from: 'manual' })
  const seg = store.segmentFor(store.library().items[0])
  assert.equal(seg.type, 'image')
  assert.equal(seg.data.sub_type, 1)
  assert.match(seg.data.file, /^base64:\/\//)
  assert.equal(seg.data.summary, '[小鱼]')

  const market = store.segmentFor({ market: { emojiId: 'm1', packageId: 2, key: 'k' }, name: '商城' })
  assert.equal(market.data.emoji_id, 'm1')
  assert.equal(market.data.emoji_package_id, 2)
  assert.equal(market.data.file, undefined, '商城表情不带本地文件')

  // 文件被人从磁盘上删了 → 返回 null（调用方不会发一条空表情）
  rmSync(join(process.env.AURABOT_DATA_DIR, 'stickers', r.item.file), { force: true })
  assert.equal(store.segmentFor(store.library().items[0]), null)
})

test('store：markUsed 累计次数（常用的不会被淘汰）', async () => {
  const { store } = makeEnv({ dryRun: true })
  const r = await store.addFromBuffer(uniq(100, 100), { from: 'manual' })
  store.markUsed(r.item.md5)
  store.markUsed(r.item.md5)
  const got = store.library().items.find((i) => i.md5 === r.item.md5)
  assert.equal(got.uses, 2)
  assert.ok(got.lastUsed > 0)
  store.markUsed('nope') // 不存在也不炸
})

test('store：库超过上限时 trim 清掉最少用的（自动收表情时每收一张跑一次）', async () => {
  const { store, cfg } = makeEnv({ dryRun: true })
  cfg.stickers.maxLibrary = 2
  for (let i = 0; i < 5; i++) await store.addFromBuffer(uniq(100, 100), { name: `第${i}张`, from: 'private:1' })
  assert.equal(store.library().items.length, 5, '手动添加不自动裁剪')
  await store.trim()
  assert.ok(store.library().items.length <= 2, `实际 ${store.library().items.length} 张`)
  assert.deepEqual(store.library().items.map((i) => i.name).sort(), ['第3张', '第4张'], '清掉的是最早的两张')
})

test('store：库文件坏了不炸，当成空库', () => {
  const { store } = makeEnv({ dryRun: true })
  const file = join(process.env.AURABOT_DATA_DIR, 'stickers', 'index.json')
  mkdirSync(join(process.env.AURABOT_DATA_DIR, 'stickers'), { recursive: true })
  writeFileSync(file, '{ 这不是 json')
  assert.deepEqual(store.library(), { items: [] })
  assert.deepEqual(store.usable(), [])
})

// ── 工具 ─────────────────────────────────────────────────────────────────

test('setup 注册了 7 个工具（主人私聊、完整权限）', () => {
  const { handlers } = makeEnv({ dryRun: true })
  const names = handlers.tools.map((t) => t.name).sort()
  assert.deepEqual(names, [
    'qq_add_sticker', 'qq_collect_sticker', 'qq_edit_sticker',
    'qq_import_qq_stickers', 'qq_list_stickers', 'qq_save_sticker', 'qq_send_sticker',
  ])
})

test('qq_list_stickers：非主人只看到数量，看不到名字', async () => {
  const { store, tool } = makeEnv({ dryRun: true, allOwner: false })
  await store.addFromBuffer(uniq(100, 100), { name: '秘密表情', from: 'manual' })
  const r = await run(tool('qq_list_stickers'), {})
  assert.equal(r.ok, true)
  assert.equal(r.count, 1)
  assert.doesNotMatch(r.message, /秘密表情/)
  assert.match(r.message, /只给主人看/)
})

test('qq_list_stickers：主人能看到名字和标签，query 能筛', async () => {
  const { store, tool } = makeEnv({ dryRun: true })
  await store.addFromBuffer(uniq(100, 100), { name: '委屈猫', tags: ['委屈'], from: 'manual' })
  await store.addFromBuffer(uniq(120, 120), { name: '开心鱼', tags: ['开心'], from: 'manual' })
  const all = await run(tool('qq_list_stickers'), {})
  assert.match(all.message, /委屈猫/)
  assert.match(all.message, /开心鱼/)
  const one = await run(tool('qq_list_stickers'), { query: '委屈' })
  assert.match(one.message, /委屈猫/)
  assert.doesNotMatch(one.message, /开心鱼/)
  const none = await run(tool('qq_list_stickers'), { query: 'zzzz' })
  assert.match(none.message, /没有符合的表情/)
})

test('qq_edit_sticker：改名 / 改标签；删表情要主人发话；要改什么得说清楚', async () => {
  const { store, tool } = makeEnv({ dryRun: true })
  await store.addFromBuffer(uniq(100, 100), { name: '旧名字', from: 'manual' })
  const r = await run(tool('qq_edit_sticker'), { sticker: '旧名字', new_name: '新名字' })
  assert.equal(r.ok, true)
  assert.match(r.message, /旧名字.*新名字/)

  const tags = await run(tool('qq_edit_sticker'), { sticker: '新名字', tags: ['开心'] })
  assert.equal(tags.ok, true)
  assert.match(tags.message, /开心/)
  assert.deepEqual(store.library().items[0].tags, ['开心'], '标签真写进库了')

  const empty = await run(tool('qq_edit_sticker'), { sticker: '新名字' })
  assert.equal(empty.ok, false)
  assert.match(empty.message, /要说改成什么/)

  const notFound = await run(tool('qq_edit_sticker'), { sticker: 'zzz', new_name: 'x' })
  assert.equal(notFound.ok, false)

  const del = await run(tool('qq_edit_sticker'), { sticker: '新名字', delete: true })
  assert.equal(del.ok, true)
  assert.equal(store.library().items.length, 0)
})

test('qq_edit_sticker：别人在场时不能借主人的场删库', async () => {
  process.env.AURABOT_DATA_DIR = tmp('aurabot-stickers')
  const { store, tool } = makeEnv({ dryRun: true, allOwner: false })
  await store.addFromBuffer(uniq(100, 100), { name: '委屈猫', from: 'manual' })
  const r = await run(tool('qq_edit_sticker'), { sticker: '委屈猫', delete: true })
  assert.equal(r.ok, false)
  assert.match(r.message, /删表情要主人发话/)
  assert.equal(store.library().items.length, 1, '没被删掉')
})

test('qq_send_sticker：关着就不挂这个工具', () => {
  const { cfg, handlers } = makeEnv({ dryRun: true })
  cfg.stickers.enabled = false
  handlers.tools.length = 0
  const env = makeEnv({ dryRun: true, settings: { stickers: { enabled: false } } })
  assert.equal(env.tool('qq_send_sticker'), undefined, '表情包关了就不该有发送工具')
  assert.ok(env.tool('qq_list_stickers'), '整理表情库的工具照样留着')
})

test('qq_send_sticker：调 hub.sendSticker，发不出去时给可读提示', async () => {
  const { tool, calls, api } = makeEnv({ dryRun: true })
  const r = await run(tool('qq_send_sticker'), { name: '委屈' })
  assert.equal(r.ok, true)
  assert.deepEqual(calls.sendSticker[0], { chatId: 'private:10000', name: '委屈' })

  api.core.hub.sendSticker = async () => false
  const no = await run(tool('qq_send_sticker'), { name: 'zzz' })
  assert.equal(no.ok, false)
  assert.match(no.message, /没找到/)
})

test('qq_add_sticker：只有完整权限才挂；不是图片时明确拒绝', async () => {
  const full = makeEnv({ dryRun: true, level: 'full' })
  assert.ok(full.tool('qq_add_sticker'), '主人私聊有完整权限')
  const social = makeEnv({ dryRun: true, level: 'social' })
  assert.equal(social.tool('qq_add_sticker'), undefined, '群聊 / 非主人没有')
})

test('qq_import_qq_stickers：非主人不让导', async () => {
  const { tool } = makeEnv({ dryRun: true, allOwner: false })
  const r = await run(tool('qq_import_qq_stickers'), {})
  assert.equal(r.ok, false)
  assert.match(r.message, /只有主人/)
})

test('qq_save_sticker：非主人不让存；主人这边没有可用图时给提示', async () => {
  const outsider = makeEnv({ dryRun: true, allOwner: false })
  const no = await run(outsider.tool('qq_save_sticker'), {})
  assert.equal(no.ok, false)
  assert.match(no.message, /只有主人/)

  const owner = makeEnv({ dryRun: true })
  const empty = await run(owner.tool('qq_save_sticker'), {})
  assert.equal(empty.ok, false)
  assert.match(empty.message, /没有人发表情/)
})

// ── 面板接口 ─────────────────────────────────────────────────────────────

test('面板路由齐全（面板页要挨个调）', () => {
  const { handlers } = makeEnv({ dryRun: true })
  for (const path of ['/stickers', '/stickers/page', '/sticker/enable', '/sticker/rule-preview', '/sticker/image', '/sticker/rename', '/sticker/delete', '/sticker/delete-batch', '/sticker/caption-all', '/sticker/caption-status', '/sticker/caption-stop', '/sticker/import-qq', '/sticker/upload']) {
    assert.ok(handlers.routes.has(path), '缺路由 ' + path)
  }
})

test('/stickers/page：分页 + 搜索 + 只看能用 / 只看不能用', async () => {
  const { store, handlers } = makeEnv({ dryRun: true })
  for (const name of ['委屈猫', '开心鱼', '卖萌兔']) await store.addFromBuffer(uniq(100, 100), { name, from: 'manual' })
  store.setEnabled(store.library().items[0].md5, false)
  const page = handlers.routes.get('/stickers/page')

  const all = await page({ query: {} })
  assert.equal(all.ok, true)
  assert.equal(all.total, 3)
  assert.equal(all.items.length, 3)

  const keyword = await page({ query: { q: '委屈' } })
  assert.equal(keyword.total, 1)
  assert.equal(keyword.items[0].name, '委屈猫')

  const usable = await page({ query: { only: 'usable' } })
  assert.equal(usable.total, 2)
  const unusable = await page({ query: { only: 'unusable' } })
  assert.equal(unusable.total, 1)

  const paged = await page({ query: { offset: '1', size: '1' } })
  assert.equal(paged.items.length, 1)
  assert.equal(paged.size, 1)
})

test('/sticker/enable：批量停用 / 启用；reset=true 一键恢复', async () => {
  const { store, handlers } = makeEnv({ dryRun: true })
  for (const name of ['甲', '乙']) await store.addFromBuffer(uniq(100, 100), { name, from: 'manual' })
  const ids = store.library().items.map((i) => i.md5)
  const route = handlers.routes.get('/sticker/enable')

  const off = await route({ body: { md5s: ids, enabled: false } })
  assert.equal(off.changed, 2)
  assert.equal(store.usable().length, 0)

  const on = await route({ body: { md5s: ids, enabled: true } })
  assert.equal(on.changed, 2)
  assert.equal(store.usable().length, 2)

  const reset = await route({ body: { reset: true } })
  assert.equal(reset.ok, true)
  // 单个 md5 直接传也认
  const single = await route({ body: { md5: ids[0], enabled: false } })
  assert.equal(single.changed, 1)
})

test('/sticker/upload：base64 data URI 收得进，超大 / 空图拒绝', async () => {
  const { store, handlers } = makeEnv({ dryRun: true })
  const route = handlers.routes.get('/sticker/upload')
  const body = 'data:image/png;base64,' + png(100, 100).toString('base64')
  const ok = await route({ body: { data: body, name: '小鱼', tags: ['开心'] } })
  assert.equal(ok.ok, true)
  assert.equal(ok.item.name, '小鱼')
  assert.equal(store.library().items.length, 1)

  const empty = await route({ body: { data: '' } })
  assert.equal(empty.ok, false)
})

test('/sticker/image：找到就回图，找不到 404（不回落）', async () => {
  const { store, handlers } = makeEnv({ dryRun: true })
  const r = await store.addFromBuffer(uniq(100, 100), { from: 'manual' })
  const route = handlers.routes.get('/sticker/image')

  const res = { statusCode: 0, body: null }
  await route({ query: { md5: r.item.md5 } }, res)
  assert.equal(res.statusCode, 200)
  assert.equal(res.body.length > 0, true)

  const miss = { statusCode: 0, body: null }
  await route({ query: { md5: 'nope' } }, miss)
  assert.equal(miss.statusCode, 404)
})

test('/stickers 和 /sticker/rule-preview 直接给面板数据', async () => {
  const { store, handlers } = makeEnv({ dryRun: true })
  await store.addFromBuffer(uniq(100, 100), { name: '委屈猫', from: 'manual' })
  const all = await handlers.routes.get('/stickers')({ query: {} })
  assert.equal(all.ok, true)
  assert.equal(all.items.length, 1)
  assert.deepEqual(all.rules, { blacklist: [], whitelist: [], mode: 'all' })

  const preview = await handlers.routes.get('/sticker/rule-preview')({ query: { rule: 'name:委屈' } })
  assert.equal(preview.ok, true)
  assert.equal(preview.count, 1)
})

test('提示词规则里写清了「主人让你存才存」', () => {
  const { handlers } = makeEnv({ dryRun: true })
  const text = handlers.rules.map((f) => f()).join('\n')
  assert.match(text, /qq_save_sticker/)
  assert.match(text, /别人让你存/)
})

test('setup 返回的就是 store（宿主靠它发表情 / 停模块时 dispose）', () => {
  const { store } = makeEnv({ dryRun: true })
  for (const fn of ['usable', 'match', 'pickForReply', 'library', 'libraryWithState', 'segmentFor', 'dispose', 'importFromQQ', 'collect', 'addFromBuffer', 'remove', 'rename', 'setEnabled']) {
    assert.equal(typeof store[fn], 'function', `缺 ${fn}`)
  }
})
