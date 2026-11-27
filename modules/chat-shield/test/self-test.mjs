// 自测：用假的 api 跑一遍核心判定，不需要上 QQ、不需要面板
// 运行：node test/self-test.mjs
import assert from 'node:assert/strict'
import mod, { normalize, similarity, parseList } from '../index.mjs'

const OWNER = '10000'
const store = {} // 模拟插件的配置存储：面板保存和命令写的是同一个对象

function makeApi(settings) {
  const handlers = new Map()
  const commands = new Map()
  const logs = []
  const api = {
    settings: () => settings,
    saveSettings: (p) => Object.assign(settings, p),
    isOwner: (uid) => String(uid) === OWNER,
    log: {
      info: (m) => logs.push(['info', m]),
      warn: (m) => logs.push(['warn', m]),
      error: (m) => logs.push(['error', m]),
      debug: () => {},
    },
    on: (name, fn) => {
      if (!handlers.has(name)) handlers.set(name, [])
      handlers.get(name).push(fn)
    },
    command: (c) => commands.set(c.name, c),
    every: () => {},
  }
  return { api, handlers, commands, logs }
}

const { api, handlers, commands, logs } = makeApi(store)
mod.setup(api)

const cmd = commands.get('屏蔽')
assert.ok(cmd, '应该注册了「屏蔽」命令')

// 按插件的方式跑 message：第一个返回 true 的接管
async function message(msg) {
  for (const fn of handlers.get('message') || []) {
    if ((await fn(msg)) === true) return true
  }
  return false
}
const reply = async (text, chatId) => {
  let out
  for (const fn of handlers.get('reply') || []) {
    const r = await fn(text, { chatId })
    if (r === null) return null
    if (r !== undefined) out = r
  }
  return out === undefined ? text : out
}
const gm = (uid, chatId, text, nickname = 'u' + uid) => ({
  kind: chatId.startsWith('group:') ? 'group' : 'private',
  chatId,
  userId: String(uid),
  groupId: chatId.startsWith('group:') ? chatId.slice(6) : '',
  text,
  nickname,
})

let n = 0
const ok = (m) => { n++; console.log('  ✓ ' + m) }

// ---------- 归一化 / 相似度 / 名单解析 ----------
assert.equal(normalize('在吗？[图片] 😀'), '在吗')
assert.ok(similarity('今天天气不错，出门走走吧', '今天天气不错 出门走走吧') > 0.9)
assert.ok(similarity('今天天气不错', '今晚吃什么') < 0.2)

const p = parseList('123456789 广告号\n987654321\n# 注释行\n\n不是号码的一行\n123456789 重复')
assert.equal(p.rows.length, 2)
assert.equal(p.rows[0].note, '广告号')
assert.deepEqual(p.bad, ['不是号码的一行'])
ok('归一化、相似度、名单解析')

// ---------- 基线 ----------
assert.equal(await message(gm(OWNER, `private:${OWNER}`, '在吗')), false)
ok('主人永远放行')
assert.equal(await message(gm(20001, 'private:20001', '在吗')), false)
ok('没拉黑的人正常放行')

// ---------- 命令写名单 ----------
assert.match(cmd.run('加 20002 广告号'), /已拉黑/)
assert.match(store.blockUsers, /20002 广告号/)
assert.equal(await message(gm(20002, 'private:20002', '你好')), true)
assert.equal(await message(gm(20002, 'group:900001', '你好')), true)
ok('命令加的号写进输入框，私聊 / 群聊都静默')

assert.equal(await reply('嗯', 'private:20002'), null)
ok('不往黑名单的私聊发消息')
assert.equal(await reply('嗯', 'private:20001'), '嗯')
ok('正常私聊照发')

// ---------- 面板输入框直接填 ----------
store.blockUsers = '20002 广告号\n30001 面板填的\n# 这是注释\n30002'
assert.equal(await message(gm(30001, 'private:30001', '在吗')), true)
assert.equal(await message(gm(30002, 'group:900002', '在吗')), true)
assert.match(cmd.run('列表'), /30001（面板填的）/)
ok('面板输入框直接填就生效（不用重启、不用命令）')

store.blockUsers = '20002 广告号'
assert.equal(await message(gm(30001, 'private:30001', '在吗')), false)
ok('从输入框删掉就立刻恢复对话')

// ---------- 群黑名单 ----------
assert.match(cmd.run('群 加 910000 广告群'), /已拉黑群/)
assert.match(store.blockGroups, /910000 广告群/)
assert.equal(await message(gm(20003, 'group:910000', '随便说')), true)
assert.equal(await reply('随便说', 'group:910000'), null)
assert.equal(await message(gm(20003, 'group:910100', '随便说')), false)
ok('群黑名单只影响该群')

// ---------- 复读 ----------
const g = gm(20004, 'group:920000', '签到')
assert.equal(await message(g), false)
assert.equal(await message(g), false)
assert.equal(await message(g), true)
assert.ok(logs.some(([, m]) => /重复同一句话/.test(m)))
assert.equal(await message(gm(20004, 'group:920000', '还在吗')), true) // 临时名单分支
ok('窗口内重复 3 次自动临时屏蔽')

// ---------- 回声（机器人互刷） ----------
const chat = 'private:20005'
assert.equal(await reply('今天的风有点大，记得加件外套', chat), '今天的风有点大，记得加件外套')
assert.equal(await message(gm(20005, chat, '今天的风有点大 记得加件外套')), false)
assert.equal(await message(gm(20005, chat, '今天的风有点大，记得加件外套。')), true)
ok('把她的话原样丢回来 ×2 后静默')

// ---------- 她自己复读 ----------
const chat2 = 'private:20006'
assert.equal(await reply('好呀，那明天见', chat2), '好呀，那明天见')
assert.equal(await reply('好呀 那明天见', chat2), null)
ok('她 90 秒内复读同句被拦下')

// ---------- 删除 / 清空 ----------
assert.match(cmd.run('删 20002'), /已移出/)
assert.equal(await message(gm(20002, 'private:20002', '你好')), false)
ok('删名单后恢复对话')

assert.match(cmd.run('清空'), /确认/)
assert.match(cmd.run('清空 确认'), /已清空/)
assert.equal(store.blockUsers, '')
assert.equal(store.blockGroups, '')
ok('清空要二次确认，确认后两个输入框一起清掉')

// ---------- 重启不丢（配置由插件保存，这里复用同一个 store） ----------
const again = makeApi(store)
await commands.get('屏蔽').run('加 20007 重启测试')
mod.setup(again.api)
const r2 = await (async () => {
  for (const fn of again.handlers.get('message') || []) {
    if ((await fn(gm(20007, 'private:20007', '在吗'))) === true) return true
  }
  return false
})()
assert.equal(r2, true)
ok('重启后黑名单仍生效')

console.log(`\n全部通过（${n} 项）`)
