// 冒烟测试：拿假的 api 跑一遍 lib/nearby.mjs，确认分拣和渲染都对。
// 不进发布包（test/ 会被排除），纯本地验证用。
// 跑法：node test/smoke.mjs

import { createNearby } from '../lib/nearby.mjs'

const OWNER = '1215734464'
const NOW = Date.now()

// ——— 假的聊天流水 ———
// 造六种情况，逐一验证哪些该出现、哪些必须挡住
const LOG = [
  // 主人私聊说了私事
  { chatId: `private:${OWNER}`, who: 'user', uid: OWNER, t: NOW - 60_000, text: '我今天心情不好，别跟人说' },
  // 七海椿私聊（别人）
  { chatId: 'private:2793067525', who: 'user', uid: '2793067525', t: NOW - 120_000, text: '我今天生日' },
  { chatId: 'private:2793067525', who: 'bot', uid: OWNER, t: NOW - 110_000, text: '喔，生日快乐' },
  // 群
  { chatId: 'group:564730311', who: 'user', uid: '2242998383', t: NOW - 180_000, text: '谢谢啦，我真的不行了' },
  // 主人自己在群里说话
  { chatId: 'group:564730311', who: 'user', uid: OWNER, t: NOW - 170_000, text: '换个浏览器就行' },
  // 应该被过滤：太短
  { chatId: 'group:564730311', who: 'user', uid: '2242998383', t: NOW - 160_000, text: '嗯' },
  // 应该被过滤：系统消息 / 命令
  { chatId: 'group:564730311', who: 'user', uid: '2242998383', t: NOW - 150_000, text: '【系统】某某加入了群聊' },
  { chatId: 'group:564730311', who: 'user', uid: '2242998383', t: NOW - 140_000, text: '/天气 北京' },
  // 应该被过滤：非聊天 id
  { chatId: 'qzone:1215734464', who: 'user', uid: OWNER, t: NOW - 130_000, text: '给你说说点了个赞' },
]

const DAY = (() => {
  const d = new Date()
  const p = (n) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`
})()

// ——— 假的 api ———
const settings = {
  enabled: true,
  hours: 24,
  quota: 3,
  maxChars: 420,
  minChars: 4,
  ownerSeesPrivate: true,
  shareGroupToGroup: false,
  othersSeeCrossChat: false,
  keepOwnerSecret: true,
}

function makeApi() {
  const names = { group: {}, person: {} }
  return {
    config: () => ({ ownerQQ: OWNER }),
    settings: () => ({ ...settings }),
    log: { info() {}, warn() {}, error() {} },
    use: (id) => (id === 'memory' ? {
      profiles: () => [{ qq: '2793067525', alias: '七海椿' }, { qq: OWNER, alias: '主人' }],
      personaPerson: async (qq) => ({ alias: names.person[qq] }),
    } : null),
    core: {
      hub: {
        chatLogOf: (day) => (day === DAY ? LOG : []),
        // 故意返回 Promise：验证异步名字不会变成 [object Promise]
        groupName: async (gid) => (gid === '564730311' ? '🦀🐖螃蟹猪猪养殖场🐖🦀' : ''),
      },
    },
    _names: names,
  }
}

// ——— 断言工具 ———
let pass = 0
let fail = 0
function check(name, cond, extra = '') {
  if (cond) { pass++; console.log(`  ✓ ${name}`) } else { fail++; console.error(`  ✗ ${name} ${extra}`) }
}

const api = makeApi()
const it = createNearby({ api })

console.log('\n[1] 主人私聊：该看到全部')
{
  const out = it.build({ kind: 'private', userId: OWNER, chatId: `private:${OWNER}` })
  check('有输出', out.length > 0)
  check('包含七海椿那段', out.includes('七海椿'))
  check('包含群里那段', out.includes('螃蟹猪猪') || out.includes('群564730311'))
  check('没有 [object Promise]', !out.includes('[object Promise]'), out.slice(0, 200))
  check('没有 qzone 记录', !out.includes('点赞'))
  check('过滤了「嗯」', !out.includes('嗯：') && !out.includes('　嗯'))
  check('过滤了系统消息', !out.includes('【系统】'))
  check('过滤了命令', !out.includes('/天气'))
  check('没渲染自己的聊天', !out.includes('我今天心情不好'))
}

console.log('\n[2] 别人私聊（默认 othersSeeCrossChat=false）：什么都不给')
{
  const out = it.build({ kind: 'private', userId: '2793067525', chatId: 'private:2793067525' })
  check('返回空串', out === '', JSON.stringify(out).slice(0, 200))
}

console.log('\n[3] 群（默认不串群）：别人的私聊不给')
{
  const out = it.build({ kind: 'group', groupId: '564730311', chatId: 'group:564730311' })
  check('返回空串', out === '', JSON.stringify(out).slice(0, 200))
}

console.log('\n[4] 打开 othersSeeCrossChat 后，别人的私聊能看，但主人的私事仍然挡住')
{
  settings.othersSeeCrossChat = true
  const out = it.build({ kind: 'private', userId: '2793067525', chatId: 'private:2793067525' })
  check('有输出', out.length > 0)
  check('看不到主人私聊那句', !out.includes('我今天心情不好'), out)
  check('看不到主人在群里说的话', !out.includes('换个浏览器就行'), out)
  check('能看群里别人的话', out.includes('我真的不行了') || out.includes('螃蟹猪猪') || out.includes('群564730311'))
  settings.othersSeeCrossChat = false
}

console.log('\n[5] 手动查询：别人被当面问，查得到')
{
  const res = it.recall({ kind: 'private', userId: '2793067525', chatId: 'private:2793067525' })
  check('ok', res.ok === true, JSON.stringify(res).slice(0, 200))
  check('有内容', typeof res.message === 'string' && res.message.length > 0)
  check('查得到群里的话', res.message.includes('我真的不行了'))
  check('仍挡住主人私聊', !res.message.includes('我今天心情不好'), res.message)
  check('仍挡住主人的发言', !res.message.includes('换个浏览器就行'), res.message)
}

console.log('\n[6] 手动查询：主人能查到全部')
{
  const res = it.recall({ kind: 'private', userId: OWNER, chatId: `private:${OWNER}` })
  check('查得到七海椿', res.message.includes('七海椿') || res.message.includes('2793067525'))
  check('查得到群', res.message.includes('我真的不行了'))
}

console.log('\n[7] 关掉模块：什么都不输出')
{
  settings.enabled = false
  const out = it.build({ kind: 'private', userId: OWNER, chatId: `private:${OWNER}` })
  check('返回空串', out === '')
  const res = it.recall({ kind: 'private', userId: OWNER, chatId: `private:${OWNER}` })
  check('工具也拒绝', res.ok === false)
  settings.enabled = true
}

console.log('\n[8] preview：统计对得上')
{
  it.clearCache()
  const p = it.preview()
  check('ok', p.ok === true)
  check('覆盖了 3 个聊天（主人/七海椿/群）', p.chatCount === 3, `实际 ${p.chatCount}`)
  // 原始 9 条里：太短×1、系统×1、命令×1、qzone×1 被滤掉，剩 5 条
  // （主人私聊 1 + 七海椿 2〔她自己+她的回复〕+ 群 2〔别人的+主人的〕）
  check('总数不含系统/命令/qzone', p.total === 5, `实际 ${p.total}: ${JSON.stringify(p.chats.map((c) => [c.chatId, c.count]))}`)
  // rawTotal = collect 之后还剩的条数（太短/系统/命令已在 collect 阶段滤掉）
  // 原始 9 条 → 滤掉「嗯」「【系统】」「/天气」→ 剩 6 条；其中 qzone 那条再被 preview 的
  // 真实聊天过滤挡掉，所以 total = 5、rawTotal = 6
  check('rawTotal 是 preview 过滤前的条数', p.rawTotal === 6, `实际 ${p.rawTotal}`)
}

console.log('\n[9] 异步名字：等一拍后应该拿到真名')
{
  it.clearCache()
  it.build({ kind: 'private', userId: OWNER, chatId: `private:${OWNER}` })
  await new Promise((r) => setTimeout(r, 60))
  const out2 = it.build({ kind: 'private', userId: OWNER, chatId: `private:${OWNER}` })
  check('群名换成了真名', out2.includes('螃蟹猪猪'), out2.slice(0, 300))
  check('人名换成了真名', out2.includes('七海椿'), out2.slice(0, 300))
}

console.log(`\n结果：${pass} 通过，${fail} 失败\n`)
process.exit(fail === 0 ? 0 : 1)
