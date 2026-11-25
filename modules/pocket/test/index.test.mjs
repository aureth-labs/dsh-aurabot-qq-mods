import { test, beforeEach } from 'node:test'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, existsSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

// 数据目录摆成真实结构：tmp/aurabot/modules-data/phone，chatlog 在 tmp/aurabot/chatlog
const ROOT = mkdtempSync(join(tmpdir(), 'phone-test-'))
const DATA_DIR = join(ROOT, 'aurabot', 'modules-data', 'phone')
const CHATLOG = join(ROOT, 'aurabot', 'chatlog')
mkdirSync(DATA_DIR, { recursive: true })
mkdirSync(CHATLOG, { recursive: true })

const OWNER = '3119752156'
const BOT = '3198936516'

// 只 setup 一次：重复 setup 会重复注册 route/监听，测试间状态会串
const mod = (await import('../index.mjs')).default
const hooks = (await import('../index.mjs')).hooks

const routes = {}
const listeners = {}
const hubCalls = []
let settingsState = { enabled: true, token: '' }
let memoryEvents = []

const api = {
  dataDir: () => DATA_DIR,
  config: () => ({ ownerQQ: OWNER, botQQ: BOT, ownerName: '老公', persona: { current: 'dafeiyu' } }),
  settings: () => ({ ...settingsState }),
  saveSettings: (patch) => { Object.assign(settingsState, patch) },
  log: { info() {}, warn() {}, error() {}, debug() {} },
  route: (path, handler) => { routes[path] = handler },
  on: (ev, fn) => { (listeners[ev] = listeners[ev] || []).push(fn) },
  use: (id) => {
    if (id === 'memory') return { addEvent: (e) => { memoryEvents.push(e); return { ok: true } }, list: () => [] }
    if (id === 'mood') return { state: () => 88, label: () => '挺开心的' }
    return null
  },
  think: async () => '…',
  onDispose: () => {},
  core: {
    http: {
      body: async (req) => (req && req.__body) || {},
      send: (res, code, buf, type) => { res.__sent = { code, buf, type } },
    },
    hub: { onMessage: async (ev) => { hubCalls.push(ev) } },
    onebot: { state: 'connected' },
  },
}

mod.setup(api)
const T = hooks.__test
assert.ok(T && T.ring, 'setup 应该挂上测试钩子')

// 宿主回调签名是 (req, res)；POST 带 JSON 头
function req(token, { body = null, url = '/', json = true } = {}) {
  const headers = {}
  if (token) headers['x-phone-token'] = token
  if (body) headers['content-type'] = json ? 'application/json' : 'text/plain'
  return { url, headers, __body: body || {} }
}

beforeEach(() => {
  T.ring().length = 0
  hubCalls.length = 0
  memoryEvents.length = 0
  settingsState.enabled = true
  // 宠物文件重置
  rmSync(join(DATA_DIR, 'pet.json'), { force: true })
})

test('首次 setup 自动生成密钥', () => {
  const t = T.tokenOf()
  assert.match(t, /^pk_/)
  assert.equal(api.settings().token, t)
})

test('无密钥 / 错密钥 / 关开关都进不来', () => {
  const token = T.tokenOf()
  const res = {}
  assert.equal(routes['/events'](req(), res), undefined)
  assert.equal(res.__sent.code, 401)
  const res2 = {}
  assert.equal(routes['/events'](req('wrong', { url: '/events' }), res2), undefined)
  assert.equal(res2.__sent.code, 401)
  settingsState.enabled = false
  const res3 = {}
  assert.equal(routes['/events'](req(token, { url: '/events' }), res3), undefined)
  assert.equal(res3.__sent.code, 403)
  settingsState.enabled = true
  const ok = routes['/events'](req(token, { url: '/events' }), {})
  assert.equal(ok.ok, true)
  assert.equal(ok.list.length, 0)
})

test('GET 可以用 ?token=（给 <audio> 标签用）', () => {
  const token = T.tokenOf()
  const r = routes['/events'](req(null, { url: `/events?token=${token}` }), {})
  assert.equal(r.ok, true)
  assert.equal(r.list.length, 0)
})

test('注入消息：走 hub，事件字段正确', async () => {
  const token = T.tokenOf()
  const r = await routes['/message'](req(token, { body: { text: '在干嘛' }, url: '/message' }), {})
  assert.equal(r.ok, true)
  assert.equal(r.via, 'hub')
  assert.equal(hubCalls.length, 1)
  const ev = hubCalls[0]
  assert.equal(ev.message_type, 'private')
  assert.equal(ev.sub_type, 'friend')
  assert.equal(String(ev.user_id), OWNER)
  assert.equal(String(ev.self_id), BOT)
  assert.equal(ev.raw_message, '在干嘛')
  assert.deepEqual(ev.message, [{ type: 'text', data: { text: '在干嘛' } }])
})

test('POST 非 JSON 被拒（CSRF 防线）', async () => {
  const token = T.tokenOf()
  const res = {}
  await routes['/message'](req(token, { body: { text: 'hi' }, url: '/message', json: false }), res)
  assert.equal(res.__sent.code, 400)
})

test('注入空消息被拒', async () => {
  const token = T.tokenOf()
  const r = await routes['/message'](req(token, { body: { text: '   ' }, url: '/message' }), {})
  assert.equal(r.ok, false)
})

test('她发出去的话（私聊）进事件环，别人和群的不会', () => {
  const token = T.tokenOf()
  for (const fn of listeners['activity'] || []) {
    fn({ kind: 'out', chatId: `private:${OWNER}`, reply: '嗯' })
    fn({ kind: 'out', chatId: 'group:123', reply: '群里说的' })
    fn({ kind: 'in', chatId: `private:${OWNER}`, text: '收到的' })
  }
  const r = routes['/events'](req(token, { url: '/events' }), {})
  assert.equal(r.ok, true)
  assert.equal(r.list.length, 1)
  assert.equal(r.list[0].type, 'her')
  assert.equal(r.list[0].text, '嗯')
})

test('events 增量拉取：after 之前的不再给', () => {
  const token = T.tokenOf()
  T.pushEvent('her', { text: '一' })
  T.pushEvent('her', { text: '二' })
  const all = routes['/events'](req(token, { url: '/events' }), {})
  assert.equal(all.list.length, 2)
  const again = routes['/events'](req(token, { url: `/events?after=${all.seq}` }), {})
  assert.equal(again.list.length, 0)
})

test('seq 游标：只给号不给事件体（app 启动时靠它跳过历史已画过的部分）', async () => {
  const token = T.tokenOf()
  const before = routes['/seq'](req(token, { url: '/seq' }), {})
  assert.equal(before.ok, true)
  assert.equal(before.list, undefined)
  // 手机走的是自带服务的路由，两条路都得通
  const hres = mockRes()
  await T.handle(mockReq({ url: '/api/seq', headers: { 'x-pocket-token': token } }), hres)
  assert.equal(hres.code, 200)
  assert.equal(JSON.parse(hres.chunks.join('')).ok, true)
  T.pushEvent('her', { text: '游标一' })
  const after = routes['/seq'](req(token, { url: '/seq' }), {})
  assert.equal(after.seq, before.seq + 1)
})

test('app-info / app-download：默认走外链（不占机主上行），本机那份只在 ?local=1 时直接发字节', async () => {
  const token = T.tokenOf()
  rmSync(join(DATA_DIR, 'app'), { recursive: true, force: true })
  rmSync(join(DATA_DIR, 'apk'), { recursive: true, force: true })
  delete settingsState.appUrl
  // 本机没放包也行：默认有 GitHub Release 兜着
  const none = T.apkOffer()
  assert.equal(none.ok, true)
  assert.equal(none.available, true)
  assert.equal(none.source, 'release')
  assert.match(none.url, /^https:\/\/github\.com\/.+\/releases\/download\/.+\.apk$/)
  assert.equal(none.local, false)
  assert.equal(none.version, '1.0.5')
  // 下载：302 去外链（浏览器自己跟过去，字节流不经过本机）
  const res302 = mockRes()
  await T.handle(mockReq({ url: `/api/app-download?token=${token}` }), res302)
  assert.equal(res302.code, 302)
  assert.equal(res302.headers.location, none.url)

  // 本机放一份：版本/大小以本机为准，但默认下载仍然 302；加 ?local=1 才走本机字节
  mkdirSync(join(DATA_DIR, 'app'), { recursive: true })
  const fake = Buffer.concat([Buffer.from('PK\u0003\u0004'), Buffer.alloc(1024, 0x61)])
  writeFileSync(join(DATA_DIR, 'app', 'pocket.apk'), fake)
  writeFileSync(join(DATA_DIR, 'app', 'pocket.apk.json'), JSON.stringify({ version: '1.0.5' }))
  try {
    const info = routes['/app-info'](req(token, { url: '/app-info' }), {})
    assert.equal(info.ok, true)
    assert.equal(info.available, true)
    assert.equal(info.size, fake.length)
    assert.equal(info.version, '1.0.5')
    assert.equal(info.local, true)
    assert.equal(info.sha256, createHash('sha256').update(fake).digest('hex'))

    // 默认还是外链
    const still302 = mockRes()
    await T.handle(mockReq({ url: `/api/app-download?token=${token}` }), still302)
    assert.equal(still302.code, 302)

    // ?local=1：走本机，类型 + 附件头 + 字节一致
    const hres = mockRes()
    await T.handle(mockReq({ url: `/api/app-download?token=${token}&local=1` }), hres)
    assert.equal(hres.code, 200)
    assert.equal(hres.type, 'application/vnd.android.package-archive')
    assert.equal(Buffer.concat(hres.chunks).equals(fake), true)

    // 机主填了自己的镜像：优先用它
    settingsState.appUrl = 'https://mirror.example.com/pocket.apk'
    const custom = T.apkOffer()
    assert.equal(custom.source, 'custom')
    assert.equal(custom.url, 'https://mirror.example.com/pocket.apk')
    const toMirror = mockRes()
    await T.handle(mockReq({ url: `/api/app-download?token=${token}` }), toMirror)
    assert.equal(toMirror.code, 302)
    assert.equal(toMirror.headers.location, 'https://mirror.example.com/pocket.apk')

    // 没密钥拿不到
    const res401 = mockRes()
    await T.handle(mockReq({ url: '/api/app-download' }), res401)
    assert.equal(res401.code, 401)
  } finally {
    delete settingsState.appUrl
    rmSync(join(DATA_DIR, 'app'), { recursive: true, force: true })
  }
  // 本机删掉后缓存必须失效：local 回到 false，但外链还在，整体仍可用
  assert.equal(T.apkInfo().available, false)
  assert.equal(T.apkOffer().available, true)
  assert.equal(T.apkOffer().local, false)
})

test('未配对的手机也能问到安装包信息（/api/app-info 不校验密钥）', async () => {
  // 新用户打开页面时手里还没有密钥，恰恰最需要下载包：这条信息必须公开。
  // （以前它跟别的接口一样要 token，导致「没配对 → 拿不到 info → 整条下载提示收起」，新用户反而没入口）
  rmSync(join(DATA_DIR, 'app'), { recursive: true, force: true })
  rmSync(join(DATA_DIR, 'apk'), { recursive: true, force: true })
  delete settingsState.appUrl
  try {
    const res = mockRes()
    await T.handle(mockReq({ url: '/api/app-info' }), res) // 故意不带 token
    assert.equal(res.code, 200)
    const body = JSON.parse(res.chunks.join(''))
    assert.equal(body.ok, true)
    assert.equal(body.available, true)
    assert.match(body.url, /^https:\/\/github\.com\/.+\/releases\/download\/.+\.apk$/)

    // 真正发字节的下载仍然要密钥，别因为公开信息把包泄了
    const dl = mockRes()
    await T.handle(mockReq({ url: '/api/app-download' }), dl)
    assert.equal(dl.code, 401)
  } finally {
    delete settingsState.appUrl
  }
})

test('带 hidden 的元素必须真能藏住（否则下载条会变成点不动的僵尸）', () => {
  const read = (p) => readFileSync(new URL('../' + p, import.meta.url), 'utf8')
  const css = read('assets/app/app.css')
  // 回归现场：.appdl 自己有 display:flex，把浏览器默认的 [hidden]{display:none} 顶掉了，
  // 于是「已经收起」的提示条一直显示，叉点了没反应、下载按钮 href 还没填。
  assert.match(css, /\.appdl\s*\{[^}]*display:\s*flex/, '.appdl 仍是 flex 布局，正是需要全局兜底的场景')
  assert.match(css, /\[hidden\]\s*\{[^}]*display:\s*none\s*!important/, 'app.css 缺全局 [hidden]{display:none !important} 兜底')
  // HTML 里这条默认是收起的，靠 JS 判断后才亮
  const html = read('assets/app/index.html')
  assert.match(html, /<div id="appdl"[^>]*\bhidden\b/, '#appdl 应该默认 hidden')
})

test('apk 目录也认 + net-info 常显版本（面板不用翻日志就知道放了哪一版）', () => {
  rmSync(join(DATA_DIR, 'app'), { recursive: true, force: true })
  rmSync(join(DATA_DIR, 'apk'), { recursive: true, force: true })
  const fake = Buffer.from('PK\u0003\u0004apk-dir')
  try {
    // 只放 apk/ 目录：总有人记成 apk/，也得能用
    mkdirSync(join(DATA_DIR, 'apk'), { recursive: true })
    writeFileSync(join(DATA_DIR, 'apk', 'pocket.apk'), fake)
    writeFileSync(join(DATA_DIR, 'apk', 'pocket.apk.json'), JSON.stringify({ version: '1.0.6' }))
    const info = T.apkInfo()
    assert.equal(info.available, true)
    assert.equal(info.version, '1.0.6')
    assert.ok(info.path.includes(join('modules-data', 'phone', 'apk')), '应该落在 apk/ 目录：' + info.path)

    // 面板数据源 /net-info 里带着 apk 信息，面板常显靠它
    const net = routes['/net-info']()
    assert.equal(net.apk.available, true)
    assert.equal(net.apk.version, '1.0.6')
    assert.equal(typeof net.apk.updatedAt, 'string')

    // 包从 apk/ 挪回 app/：缓存必须按 path 失效，不能沿用 apk/ 那份的 hash/版本
    mkdirSync(join(DATA_DIR, 'app'), { recursive: true })
    writeFileSync(join(DATA_DIR, 'app', 'pocket.apk'), fake)
    writeFileSync(join(DATA_DIR, 'app', 'pocket.apk.json'), JSON.stringify({ version: '1.0.7' }))
    const moved = T.apkInfo()
    assert.ok(moved.path.includes(join('modules-data', 'phone', 'app')), 'app/ 优先：' + moved.path)
    assert.equal(moved.version, '1.0.7')
    assert.equal(moved.sha256, createHash('sha256').update(fake).digest('hex'))
  } finally {
    rmSync(join(DATA_DIR, 'app'), { recursive: true, force: true })
    rmSync(join(DATA_DIR, 'apk'), { recursive: true, force: true })
  }
  assert.equal(T.apkInfo().available, false)
})

test('events 超过 200 条时 seq 停在批尾，不跳到全局（否则中间的事件会丢）', () => {
  const token = T.tokenOf()
  const from = routes['/seq'](req(token, { url: '/seq' }), {}).seq
  for (let i = 0; i < 205; i++) T.pushEvent('her', { text: '批量' + i })
  const first = routes['/events'](req(token, { url: `/events?after=${from}` }), {})
  assert.equal(first.list.length, 200)
  assert.equal(first.seq, from + 200)
  const second = routes['/events'](req(token, { url: `/events?after=${first.seq}` }), {})
  assert.equal(second.list.length, 5)
  assert.equal(second.seq, from + 205)
})

test('同一批事件重复拉取时，客户端按 seq 去重后不会重画', () => {
  // 手机弱网时几个请求带着同一个 after= 并发回来，都会拿到同一批；
  // app 里判断 e.seq <= S.seq 就丢，这里模拟那个循环，确认只会画一遍
  const token = T.tokenOf()
  const from = routes['/seq'](req(token, { url: '/seq' }), {}).seq
  T.pushEvent('her', { text: '重复测试' })
  const batch = routes['/events'](req(token, { url: `/events?after=${from}` }), {}).list
  let seq = from
  const drawn = []
  for (let round = 0; round < 3; round++) {
    for (const e of batch) {
      if (Number(e.seq) <= seq) continue
      seq = Number(e.seq)
      drawn.push(e.text)
    }
  }
  assert.deepEqual(drawn, ['重复测试'])
})

test('投喂：数值上升、写入她的记忆、冷却与上限生效', async () => {
  const token = T.tokenOf()
  const r1 = await routes['/pet'](req(token, { body: { action: 'feed', food: 'rice' }, url: '/pet' }), {})
  assert.equal(r1.ok, true)
  assert.ok(r1.state.satiety > 62)
  assert.equal(memoryEvents.length, 1)
  assert.match(memoryEvents[0].text, /白米饭/)

  // 20 秒冷却内再喂会被拒
  const r2 = await routes['/pet'](req(token, { body: { action: 'feed', food: 'rice' }, url: '/pet' }), {})
  assert.equal(r2.refused, true)

  // 饱食度顶满拒绝
  rmSync(join(DATA_DIR, 'pet.json'), { force: true })
  writeFileSync(join(DATA_DIR, 'pet.json'), JSON.stringify({ satiety: 99, mood: 80, intimacy: 5, lastTick: Date.now(), lastFeedAt: 0, lastPetAt: 0 }), 'utf8')
  const r3 = await routes['/pet'](req(token, { body: { action: 'feed' }, url: '/pet' }), {})
  assert.equal(r3.refused, true)
  assert.match(r3.reply, /撑死/)
})

test('投喂回应：每款 10~15 句，随机挑且不会连着重复同一句', () => {
  const { FOODS, feedLine } = T
  for (const [id, f] of Object.entries(FOODS)) {
    assert.ok(Array.isArray(f.lines), `${id} 要有 lines 数组`)
    assert.ok(f.lines.length >= 10 && f.lines.length <= 15, `${id} 只有 ${f.lines.length} 句，要求 10~15`)
    assert.equal(new Set(f.lines).size, f.lines.length, `${id} 的句子里有重复`)
    assert.ok(f.lines.every((s) => typeof s === 'string' && s.trim().length >= 2), `${id} 有空句`)
  }
  // 随机性 + 不连续重复：同一款连抽 30 次
  const seen = new Set()
  let prev = ''
  for (let i = 0; i < 30; i++) {
    const line = feedLine('cake', FOODS.cake)
    assert.ok(FOODS.cake.lines.includes(line), '抽到了不属于该款的句子')
    assert.notEqual(line, prev, `第 ${i} 次和上一次是同一句`)
    prev = line
    seen.add(line)
  }
  assert.ok(seen.size >= 4, `30 次只出现 ${seen.size} 种，随机性不够`)
  // 各款互不串味
  const all = Object.values(FOODS).flatMap((f) => f.lines)
  assert.equal(new Set(all).size, all.length, '不同食物之间有重复句子')

  // 摸摸头（心情两套）与陪玩：也不能只有一句，否则点两下就腻
  for (const [k, list] of Object.entries(T.PET_LINES)) {
    assert.ok(list.length >= 6, `摸摸头 ${k} 只有 ${list.length} 句`)
    assert.equal(new Set(list).size, list.length, `摸摸头 ${k} 有重复`)
  }
  assert.ok(T.PLAY_LINES.length >= 8, `陪玩只有 ${T.PLAY_LINES.length} 句`)
  assert.equal(new Set(T.PLAY_LINES).size, T.PLAY_LINES.length, '陪玩有重复')
})

test('摸摸头 / 陪玩真的会换着说', async () => {
  const token = T.tokenOf()
  const seen = new Set()
  for (let i = 0; i < 12; i++) {
    const r = await routes['/pet'](req(token, { body: { action: 'play' }, url: '/pet' }), {})
    assert.equal(r.ok, true)
    assert.ok(T.PLAY_LINES.includes(r.reply), '回复不在陪玩句库里：' + r.reply)
    seen.add(r.reply)
  }
  assert.ok(seen.size >= 3, `12 次陪玩只出现 ${seen.size} 种句子`)
})

test('隧道重建换地址时，记下旧地址和变更时间（面板据此提醒手机重新配对）', () => {
  const f = join(DATA_DIR, 'tunnel.json')
  // 先放一条旧地址
  writeFileSync(f, JSON.stringify({ url: 'https://old-name.trycloudflare.com', pid: 1, at: Date.now() }), 'utf8')
  assert.equal(T.readTunnelFile().url, 'https://old-name.trycloudflare.com')

  // 地址变了：必须记 prevUrl + changedAt
  const before = Date.now()
  const a = T.saveTunnel({ url: 'https://new-name.trycloudflare.com', pid: 2, at: Date.now() })
  assert.equal(a.prevUrl, 'https://old-name.trycloudflare.com')
  assert.ok(a.changedAt >= before, 'changedAt 要记成变更时刻')
  const onDisk = T.readTunnelFile()
  assert.equal(onDisk.prevUrl, 'https://old-name.trycloudflare.com')

  // 地址没变（重启同一条 named/同域名）：变更记录要保留，不能被清掉
  const b = T.saveTunnel({ url: 'https://new-name.trycloudflare.com', pid: 3, at: Date.now() })
  assert.equal(b.prevUrl, 'https://old-name.trycloudflare.com')
  assert.equal(b.changedAt, a.changedAt, '地址没变就不该刷新变更时间')

  // 面板读的字段要在 tunnelInfo 里露出来
  const info = T.tunnelInfo()
  assert.equal(info.prevUrl, 'https://old-name.trycloudflare.com')
  assert.ok(info.changedAt > 0)
  rmSync(f, { force: true })
})

test('diag：记录最近访问（谁打过、从公网还是本机、哪个域名）', async () => {
  const token = T.tokenOf()
  // 先打一次 health（不需要密钥），再打 diag
  const h = mockRes()
  await T.handle(mockReq({ url: '/api/health' }), h)
  assert.equal(h.code, 200)
  const d = mockRes()
  await T.handle(
    mockReq({
      url: `/api/diag?token=${token}`,
      headers: { host: 'petroleum-x.trycloudflare.com', 'cf-ray': 'abc', 'cf-connecting-ip': '1.2.3.4', 'user-agent': 'okhttp/4.9' },
    }),
    d,
  )
  assert.equal(d.code, 200)
  const body = JSON.parse(Buffer.concat(d.chunks).toString('utf8'))
  assert.equal(body.ok, true)
  assert.equal(body.version, T.VERSION)
  assert.ok(Array.isArray(body.hits) && body.hits.length >= 2)
  const last = body.hits[body.hits.length - 1]
  assert.equal(last.path, '/api/diag')
  assert.equal(last.via, 'cloudflare') // 带 cf-ray 说明请求是从隧道进来的
  assert.equal(last.ip, '1.2.3.4')
  assert.equal(last.host, 'petroleum-x.trycloudflare.com')
  assert.ok(body.probe && typeof body.probe.fails === 'number')

  // 没密钥不给看（访问记录里带 IP，属于内部信息）
  const noauth = mockRes()
  await T.handle(mockReq({ url: '/api/diag' }), noauth)
  assert.equal(noauth.code, 401)
})

test('diag：隧道自检自己打的请求不算「有人访问」', async () => {
  const token = T.tokenOf()
  // 自检请求带 x-pocket-probe 标记
  const p1 = mockRes()
  await T.handle(mockReq({ url: '/api/health', headers: { 'x-pocket-probe': '1', 'cf-ray': 'x' } }), p1)
  const d = mockRes()
  await T.handle(mockReq({ url: `/api/diag?token=${token}` }), d)
  const body = JSON.parse(Buffer.concat(d.chunks).toString('utf8'))
  const probes = body.hits.filter((x) => x.probe)
  assert.ok(probes.length >= 1, '自检请求应被标记')
  assert.equal(probes[probes.length - 1].path, '/api/health')

  // 面板只拿真实访问：全是自检时 recent 里不该有东西
  const ni = routes['/net-info']()
  assert.ok(Array.isArray(ni.recent))
  assert.equal(ni.recent.every((x) => !x.probe), true, 'recent 里混进了自检')

  // 真设备打一次，就要出现在 recent 里
  const real = mockRes()
  await T.handle(mockReq({ url: '/api/health', headers: { 'cf-ray': 'y', 'cf-connecting-ip': '9.9.9.9', 'user-agent': 'okhttp' } }), real)
  const ni2 = routes['/net-info']()
  assert.equal(ni2.recent[ni2.recent.length - 1].ip, '9.9.9.9')
})

test('隧道：手动「停止→启动」换了域名也能记上（tunnel.json 被删也照样提示）', async () => {
  // 前面用例可能留下状态，先清干净
  rmSync(join(DATA_DIR, 'tunnel.json'), { force: true })
  rmSync(join(DATA_DIR, 'tunnel-last.json'), { force: true })
  const first = T.saveTunnel({ url: 'https://aaa.trycloudflare.com', pid: 1, at: 1 })
  assert.equal(first.prevUrl, undefined)
  // 停止隧道会删掉 tunnel.json —— 这里直接删，模拟「停止」之后又手动启动
  rmSync(join(DATA_DIR, 'tunnel.json'), { force: true })
  const second = T.saveTunnel({ url: 'https://bbb.trycloudflare.com', pid: 2, at: 2 })
  assert.equal(second.prevUrl, 'https://aaa.trycloudflare.com', '手动重启换了域名必须记 prevUrl')
  assert.ok(second.changedAt > 0)
  // tunnel.json 再次被删（停止状态）时，tunnelInfo 仍能从隧道历史里给出「上次换过地址」
  rmSync(join(DATA_DIR, 'tunnel.json'), { force: true })
  const info = T.tunnelInfo()
  assert.equal(info.prevUrl, 'https://aaa.trycloudflare.com')
  assert.ok(info.changedAt > 0)
  rmSync(join(DATA_DIR, 'tunnel-last.json'), { force: true })
})

test('state 返回人格、心情和宠物数值', () => {
  const token = T.tokenOf()
  const r = routes['/state'](req(token, { url: '/state' }), {})
  assert.equal(r.ok, true)
  assert.equal(r.persona, 'dafeiyu')
  assert.equal(r.mood, 88)
  assert.equal(r.owner, '老公')
  assert.equal(typeof r.pet.satiety, 'number')
})

test('皮肤：没自定义包时给内置默认', () => {
  const token = T.tokenOf()
  const r = routes['/skin'](req(token, { url: '/skin' }), {})
  assert.equal(r.ok, true)
  assert.equal(r.builtin, true)
  assert.equal(r.skin.persona, 'dafeiyu')
  assert.ok(r.skin.whale)
})

test('history：只取主人私聊', () => {
  writeFileSync(join(CHATLOG, '2026-11-14.jsonl'), [
    JSON.stringify({ t: Date.now(), chatId: `private:${OWNER}`, who: 'bot', text: '定啦' }),
    JSON.stringify({ t: Date.now(), chatId: 'private:999', who: 'bot', text: '别人的' }),
    JSON.stringify({ t: Date.now(), chatId: `private:${OWNER}`, who: 'user', text: '吃饭没' }),
    JSON.stringify({ t: Date.now(), chatId: 'group:1', who: 'bot', text: '群里的' }),
  ].join('\n'), 'utf8')
  const token = T.tokenOf()
  const r = routes['/history'](req(token, { url: '/history?days=3' }), {})
  assert.equal(r.ok, true)
  assert.equal(r.list.length, 2)
  assert.deepEqual(r.list.map((x) => x.who), ['her', 'me'])
})

test('语音：voice 模组没在跑时明确报错', async () => {
  const token = T.tokenOf()
  const r = await routes['/voice'](req(token, { url: `/voice?text=${encodeURIComponent('你好')}` }), {})
  assert.equal(r.ok, false)
  assert.match(r.message, /语音模组/)
})

test('色调：合法 key 才收，写进设置', async () => {
  const token = T.tokenOf()
  const bad = await routes['/tone'](req(token, { body: { tone: 'hacker-green' }, url: '/tone' }), {})
  assert.equal(bad.ok, false)
  const good = await routes['/tone'](req(token, { body: { tone: 'sakura' }, url: '/tone' }), {})
  assert.equal(good.ok, true)
  assert.equal(api.settings().tone, 'sakura')
  const st = routes['/state'](req(token, { url: '/state' }), {})
  assert.equal(st.tone, 'sakura')
  assert.ok(st.tones.includes('ocean'))
  settingsState.tone = ''
})

test('自带服务：/api/health 不用密钥，其他接口要', async () => {
  const token = T.tokenOf()
  assert.ok(T.handle, 'handle 应该挂上')
  const hres = mockRes()
  await T.handle(mockReq({ url: '/api/health' }), hres)
  assert.equal(hres.code, 200)
  const res401 = mockRes()
  await T.handle(mockReq({ url: '/api/state' }), res401)
  assert.equal(res401.code, 401)
  const resOk = mockRes()
  await T.handle(mockReq({ url: '/api/state', headers: { 'x-pocket-token': token } }), resOk)
  assert.equal(resOk.code, 200)
  const body = JSON.parse(resOk.chunks.join(''))
  assert.equal(body.ok, true)
  assert.equal(body.persona, 'dafeiyu')
})

test('自带服务：静态文件越界被拦', async () => {
  const res = mockRes()
  await T.handle(mockReq({ url: '/..%2f..%2f..%2fwindows%2fwin.ini' }), res)
  assert.notEqual(res.code, 200)
})

// ---------- 图片 / 语音 / emoji（emoji 本身就是文字，走原路） ----------

const PNG_1PX = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64')

test('图片解码：dataURL / 裸 base64 收，非图和超限拒', () => {
  assert.ok(T.decodeImage('data:image/png;base64,' + PNG_1PX.toString('base64')), 'dataURL 应该收')
  assert.ok(T.decodeImage(PNG_1PX.toString('base64')), '裸 base64 应该收')
  assert.equal(T.decodeImage('not-base64!!'), null)
  assert.equal(T.decodeImage(''), null)
  const fake = Buffer.from('A'.repeat(13 * 1024 * 1024)).toString('base64')
  assert.equal(T.decodeImage(fake), null, '超过上限应该拒')
  const txt = Buffer.from('hello world this is plain text not an image at all ok').toString('base64')
  assert.equal(T.decodeImage(txt), null, '纯文本 base64 不是图')
})

test('发图：注入消息带图片段（图在前字在后）', () => {
  hubCalls.length = 0
  const r = T.inject('你看这个', 'data:image/png;base64,' + PNG_1PX.toString('base64'))
  assert.equal(r.ok, true)
  assert.equal(hubCalls.length, 1)
  const segs = hubCalls[0].message
  assert.equal(segs.length, 2)
  assert.equal(segs[0].type, 'image')
  assert.ok(segs[0].data.file.startsWith('base64://'))
  assert.equal(segs[1].type, 'text')
  assert.equal(segs[1].data.text, '你看这个')
  // 纯图没字也能发
  hubCalls.length = 0
  const r2 = T.inject('', PNG_1PX.toString('base64'))
  assert.equal(r2.ok, true)
  assert.equal(hubCalls[0].message.length, 1)
  // 空的什么都没有 → 拒
  assert.equal(T.inject('', '').ok, false)
})

test('她发图给主人：send 钩子抓 image 段推 her-media 事件', async () => {
  const token = T.tokenOf()
  const before = T.ring().length
  const sendFns = listeners.send || []
  assert.ok(sendFns.length, '应该注册了 send 钩子')
  for (const fn of sendFns) {
    await fn(
      [{ type: 'text', data: { text: '看这个' } }, { type: 'image', data: { file: 'base64://' + PNG_1PX.toString('base64') } }],
      { chatId: `private:${OWNER}` }
    )
  }
  const events = T.ring().slice(before)
  const media = events.filter((e) => e.type === 'her-media')
  assert.equal(media.length, 1)
  assert.equal(media[0].kind, 'image')
  assert.equal(media[0].mime, 'image/png')
  assert.ok(media[0].data.length > 50)
  // 发给别人的不抓
  const b2 = T.ring().length
  for (const fn of sendFns) await fn([{ type: 'image', data: { file: 'base64://' + PNG_1PX.toString('base64') } }], { chatId: 'private:other' })
  assert.equal(T.ring().length, b2, '别人的聊天不应该推事件')
  // 文字段不重复推（文字走 activity）
  const b3 = T.ring().length
  for (const fn of sendFns) await fn([{ type: 'text', data: { text: '只是文字' } }], { chatId: `private:${OWNER}` })
  assert.equal(T.ring().length, b3, '纯文字不推媒体事件')
  // 干跑模式按没发算
  settingsState.enabled = true
})

test('语音条：DSH 没开识别时明确报错；开了就转文字注入', async () => {
  const fake = 'T2xhaFNIUlVMQUhVUmFIVVJs' // 随便一段 base64（不是真音频，会走到 stt 检查或转码失败）
  const r1 = await T.voiceNote(fake)
  // 测试环境 dsh 没配 → 应该报「没开语音输入」
  assert.equal(r1.ok, false)
  assert.match(r1.message, /语音输入|ffmpeg|听清/)
  assert.equal((await T.voiceNote('')).ok, false)
})

test('her-media 语音事件：record 段转 base64 推给 app', async () => {
  // 构造一个假 wav（RIFF 头）
  const wav = Buffer.concat([Buffer.from('RIFF\x24\x00\x00\x00WAVEfmt \x10\x00\x00\x00'), Buffer.alloc(28)])
  const sendFns = listeners.send || []
  const before = T.ring().length
  for (const fn of sendFns) await fn([{ type: 'record', data: { file: 'base64://' + wav.toString('base64') } }], { chatId: `private:${OWNER}` })
  const events = T.ring().slice(before)
  const media = events.filter((e) => e.type === 'her-media' && e.kind === 'voice')
  assert.equal(media.length, 1)
  assert.equal(media[0].mime, 'audio/wav')
})

test('隧道：一键下载固定版本 + SHA-256 校验，内容不符必须拒绝且不落盘', async () => {
  const p = T.cfPolicy
  assert.equal(p.version, '2026.11.0', '必须固定版本，不能再用 releases/latest')
  assert.ok(p.size > 40 * 1024 * 1024, '官方大小应当大于 40MB')
  assert.match(p.sha256, /^[0-9a-f]{64}$/, 'SHA-256 必须是 64 位小写 hex')
  assert.ok(p.mirrors[0].startsWith('https://github.com/cloudflare/cloudflared/releases/download/'), '首选必须是官方固定版本地址')
  assert.ok(!p.mirrors[0].includes('/latest/'), '首选不能是 latest')

  const dest = join(DATA_DIR, 'bin', 'cloudflared.exe')
  rmSync(dest, { force: true })
  const realFetch = globalThis.fetch
  try {
    // 大小对、内容被换过 —— 模拟镜像投毒，必须拒绝且不写盘
    globalThis.fetch = async () => new Response(Buffer.alloc(p.size, 0), { status: 200 })
    const bad = await T.installCloudflared()
    assert.equal(bad.ok, false, 'hash 不符不能算成功')
    assert.match(bad.message, /SHA-256/)
    assert.equal(existsSync(dest), false, '校验失败绝不能把文件写进去')

    // 大小不对（错误页 / 被截断）—— 也要拒绝
    globalThis.fetch = async () => new Response(Buffer.alloc(2048, 0), { status: 200 })
    const small = await T.installCloudflared()
    assert.equal(small.ok, false)
    assert.match(small.message, /大小/)
  } finally {
    globalThis.fetch = realFetch
  }
})

function mockRes() {
  return { code: 0, type: '', headers: {}, chunks: [], writeHead(c, h) { this.code = c; this.headers = h || {}; this.type = this.headers['content-type'] }, end(b) { if (b) this.chunks.push(b) } }
}
function mockReq({ url = '/', headers = {}, method = 'GET' } = {}) {
  return { url, headers, method }
}

test('换了隧道域名：从新链接打开就自动认新地址（不再死磕手机里存的旧域名）', () => {
  const src = readFileSync(new URL('../assets/app/app.js', import.meta.url), 'utf8')
  // quick 隧道重建必换域名，而二维码退回的短链只带 token、不带 host：
  // 不做这个自愈，页面能从新链接打开，但所有 /api 还在打早就 1033 的旧域名。
  assert.match(src, /function adoptUrlHost\(/, '缺 adoptUrlHost：从新地址打开时不会自愈')
  assert.match(src, /else\s*\{\s*adoptUrlHost\(\)\s*\}/, 'takeFromUrl 在没有显式 host 参数时必须调用 adoptUrlHost')
  assert.match(src, /const origin = location\.origin/, '要用「页面是从哪个地址打开的」作为首选地址')
  // 显式带 host 的链接（面板「复制配对链接」）优先级更高，不能被覆盖
  assert.ok(src.indexOf('if (host) {') < src.indexOf('adoptUrlHost()'), '显式 host 必须先处理')
})

test('http 地址下录音按钮要说清原因，别拿「检查权限」把人带偏', () => {
  const read = (p) => readFileSync(new URL('../' + p, import.meta.url), 'utf8')
  const src = read('assets/app/app.js')
  // 非安全上下文里 navigator.mediaDevices 直接不存在 —— 不是权限问题，授权也永远拿不到
  assert.match(src, /const WEB_MIC_OK = typeof navigator\.mediaDevices\?\.getUserMedia === 'function'/)
  assert.match(src, /const MIC_NEEDS_HTTPS = !NATIVE_MIC && !WEB_MIC_OK/)
  assert.match(src, /这个地址是 http，浏览器不给录音权限/)
  // 按钮本身要有可见状态，不能装作能按
  assert.match(read('assets/app/app.css'), /\.mic-off\s*\{[\s\S]*?opacity/)
})

test('新用户第一次按话筒：先引导「点允许再按一次」，不能显示「拿不到麦克风」', () => {
  const src = readFileSync(new URL('../assets/app/app.js', import.meta.url), 'utf8')
  // 壳在没授权时返回「还没给麦克风权限，我再问一次」——权限框正在弹，不是失败。
  // 旧代码把它当 error 直接显示「拿不到麦克风」，新用户第一反应就是功能坏了。
  assert.match(src, /const needPerm = \/权限\|permission\/i\.test\(r\)/, '要把「要权限」和「真失败」分开')
  assert.match(src, /h\.needPerm\s*\n?\s*\?/, 'startRec 里要按 needPerm 走引导分支')
  assert.match(src, /第一次用要先允许麦克风/, '要有「点允许再按一次」的引导文案')
  assert.ok(
    src.indexOf('第一次用要先允许麦克风') > src.indexOf('h.needPerm'),
    '引导分支必须在「拿不到麦克风」之前生效',
  )
  // 浏览器侧：被拒（含 QQ/微信内核拦截）与设备缺失要分开说
  assert.match(src, /NotAllowedError/, '要单独处理 NotAllowedError（内核拦截最常见）')
  assert.match(src, /NotFoundError/, '要单独处理 NotFoundError')
  // 原生录音没回音时不能静默：界面已恢复，用户会以为「按了没反应」
  assert.match(src, /这条语音没录上：麦克风可能被别的应用占着/)
})

test('环境自检：四项状态 + 一句「能连到哪里」的结论（云电脑最容易缺 ffmpeg）', () => {
  const e = routes['/env']()
  assert.equal(e.ok, true)
  assert.equal(typeof e.ffmpeg.ok, 'boolean', 'ffmpeg 要有明确状态')
  assert.ok(e.ffmpeg.ok || e.ffmpeg.why, '缺 ffmpeg 要说清缺在哪')
  assert.equal(typeof e.cloudflared.ok, 'boolean')
  assert.equal(typeof e.tunnel.ok, 'boolean')
  assert.equal(typeof e.token.ok, 'boolean')
  assert.ok(['anywhere', 'lan', 'lan-only'].includes(e.reach), '给结论：任何网络 / 只同一 WiFi')
  assert.match(e.dataDir, /modules-data/i, '暴露数据目录——云电脑还原盘据此提醒会丢配置')

  const p = readFileSync(new URL('../panel.js', import.meta.url), 'utf8')
  assert.match(p, /运行环境自检/, '面板要有这张卡片')
  assert.match(p, /winget install Gyan\.FFmpeg/, '缺 ffmpeg 时给出装法')
  assert.match(p, /关机还原/, '云电脑还原盘要提醒')
  assert.ok(p.indexOf("call('/env')") > 0, '面板要单独异步拉自检，别拖慢首发')
})
