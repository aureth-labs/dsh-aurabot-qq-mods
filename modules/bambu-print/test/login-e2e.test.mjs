// test/login-e2e.test.mjs —— 「用户拿到链接 → 浏览器填表 → 贴回 → 登录成功」整条链路的真实端到端。
//
// 与 enroll-page.test.mjs 的分工：那边只验证「浏览器生成的密文能被信封服务解开」；
// 这边把**整个装配层**接进来 —— 模块自己的 /enroll 公钥、真浏览器填表、真命令入口、
// 真 vault 落盘，只把「真正去 Bambu 云端」那一次调用换成桩（没有真账号可用）。
//
// 没装浏览器的机器上自动跳过，不会让 CI 变红。
import test from 'node:test'
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { readFile, mkdtemp, rm, readdir } from 'node:fs/promises'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { existsSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import mod from '../index.mjs'

const run = promisify(execFile)

function findBrowser () {
  const list = [
    process.env.BAMBU_TEST_BROWSER,
    'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
    'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
    'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
    '/usr/bin/google-chrome', '/usr/bin/chromium', '/usr/bin/chromium-browser',
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  ].filter(Boolean)
  return list.find((p) => existsSync(p)) || ''
}

test('真浏览器登录：拿到链接 → 填表 → 贴回 → 登录成功，且秘密不进聊天', async (t) => {
  const browser = findBrowser()
  if (!browser) { t.skip('本机没有 Edge/Chrome，跳过（设 BAMBU_TEST_BROWSER 可指定）'); return }

  const dir = await mkdtemp(path.join(os.tmpdir(), 'login-e2e-'))
  const settings = { active: true, users: '200002', groupMode: 'status', groupPhoto: true, allowGroupName: false, unlockDays: 7, maxBindings: 5, requestTimeoutMs: 2000, selectedTtlMinutes: 10, defaultInterface: 'cloud', ownerInterface: '', ownerLocalAllowed: true, tutkBridgePath: '', tutkLibPath: '', tutkTimeoutMs: 8000 }
  const routes = new Map(); const replies = []; const handlers = []
  const manager = {
    targetKey: (x) => [x.mode, x.host, x.serial].join('|'), closeAll () {},
    async status () { return { ok: true, stale: false, receivedAt: Date.now(), report: { print: { gcode_state: 'RUNNING', mc_percent: '42', mc_remaining_time: '98', layer_num: '5', total_layer_num: '10' } } } },
    async command () { return { ok: true } },
  }
  const api = {
    id: 'bambu-print', settings: () => settings, saveSettings: (p) => Object.assign(settings, p),
    dataDir: (...p) => path.join(dir, ...p),
    config: () => ({ ownerQQ: '100001', allow: { private: ['200002'], groups: [] } }),
    isOwner: (qq) => String(qq) === '100001',
    log: { info () {}, warn () {}, error () {}, debug () {} },
    reply: async (m, x) => replies.push(String(x)),
    sendImage: async () => {}, onebot: async () => ({}), command: () => {},
    route: (p, fn) => routes.set(p, fn), tool: () => {}, rule: () => {}, context: () => {},
    on: (e, fn) => handlers.push({ e, fn }), onDispose: () => {}, defineTool: (x) => x,
    core: { http: { body: async (r) => r.__body || {}, query: () => ({}) } },
    __bambuTestHooks: {
      printerManager: manager,
      listDevices: async () => ({ ok: true, devices: [{ serial: '01S00C000000001', name: 'X1C', model: 'X1C' }] }),
      // 只桩「真正去 Bambu 云端」这一步：没有真账号
      createCloudLogin: () => ({
        async login () { return { ok: true, accessToken: 'E2E-TOKEN-abcdef123456', uid: '123456', region: 'cn' } },
        async requestCode () { return { ok: true, channel: 'email' } },
        async submitCode () { return { ok: true, accessToken: 'E2E-TOKEN-abcdef123456', uid: '123456', region: 'cn' } },
        async submitTfa () { return { ok: true, accessToken: 'E2E-TOKEN-abcdef123456', uid: '123456', region: 'cn' } },
      }),
    },
  }
  const def = mod.default || mod
  def.setup(api)
  const call = (p, b) => routes.get(p)({ __body: b || {}, __query: b || {} })
  const say = async (text) => {
    replies.length = 0
    const m = { kind: 'private', chatId: 'private:200002', userId: '200002', groupId: '', nickname: 'u', role: '', text, messageId: 'm', images: [], stickers: [], records: [], forwards: [], raw: {} }
    for (const h of handlers.filter((x) => x.e === 'message')) { if (await h.fn(m)) break }
    return replies.at(-1) || ''
  }

  const ENROLL_DIR = path.resolve(import.meta.dirname, '..', 'assets', 'enroll')
  const ACCOUNT = 'tester@example.com'
  const PASSWORD = 'MyBambuPass#2026'
  let server = null
  let ud = null
  try {
    // 1) 用户发 /打印机 登录 拿链接
    const linkReply = await say('/打印机 登录')
    const pub = linkReply.match(/#k=([A-Za-z0-9_-]{87})/)
    assert.ok(pub, '链接里应当有 87 字符公钥：' + linkReply)

    // 2) 起静态服务，把 assets/enroll 原样发出去（外加一个内存里的驱动页）
    const wrapper = '<!doctype html><meta charset="utf-8"><iframe id="f" src="./index.html#k=' + pub[1] + '" style="width:900px;height:1400px"></iframe><pre id="out">PENDING</pre><script>'
      + 'const f=document.getElementById("f"),out=document.getElementById("out");'
      + 'f.addEventListener("load",function(){const w=f.contentWindow,d=f.contentDocument;const t0=Date.now();'
      + 'const tick=function(){const btn=d.getElementById("generate");if(!btn||btn.disabled){if(Date.now()-t0>12000)return out.textContent="ERR: 页面没就绪";return setTimeout(tick,100)}'
      + 'const set=function(id,v){const el=d.getElementById(id);el.value=v;el.dispatchEvent(new w.Event("input",{bubbles:true}))};'
      + 'set("account",' + JSON.stringify(ACCOUNT) + ');set("password",' + JSON.stringify(PASSWORD) + ');'
      + 'd.getElementById("form").dispatchEvent(new w.Event("submit",{bubbles:true,cancelable:true}));'
      + 'const wait=function(){const res=d.getElementById("result"),txt=d.getElementById("output").value;'
      + 'if(res&&!res.hidden&&txt){out.textContent=txt;return}if(Date.now()-t0>15000){const i=d.getElementById("issues");return out.textContent="ERR: "+(i?i.innerText:"?")}setTimeout(wait,100)};wait()};'
      + 'setTimeout(tick,100)});<\/script>'
    server = createServer(async (req, res) => {
      const u = new URL(req.url, 'http://127.0.0.1')
      const name = u.pathname === '/' ? 'index.html' : u.pathname.replace(/^\//, '')
      if (name === 'e2e.html') { res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' }); res.end(wrapper); return }
      if (!/^[\w.-]+$/.test(name)) { res.writeHead(400); res.end(); return }
      try {
        const bodyBuf = await readFile(path.join(ENROLL_DIR, name))
        const type = name.endsWith('.html') ? 'text/html; charset=utf-8' : name.endsWith('.js') ? 'text/javascript; charset=utf-8' : name.endsWith('.css') ? 'text/css; charset=utf-8' : 'application/octet-stream'
        res.writeHead(200, { 'content-type': type }); res.end(bodyBuf)
      } catch { res.writeHead(404); res.end() }
    })
    await new Promise((r) => server.listen(0, '127.0.0.1', r))
    const origin = 'http://127.0.0.1:' + server.address().port

    // 3) 真浏览器：打开、填表、点生成
    ud = await mkdtemp(path.join(os.tmpdir(), 'edge-'))
    const { stdout } = await run(browser, ['--headless=new', '--disable-gpu', '--no-sandbox', '--no-first-run', '--disable-dev-shm-usage', '--virtual-time-budget=9000', '--user-data-dir=' + ud, '--dump-dom', origin + '/e2e.html'], { timeout: 45000, maxBuffer: 8 * 1024 * 1024 })
    const mm = stdout.match(/<pre id="out">([^<]*)<\/pre>/)
    assert.ok(mm, '浏览器没有输出结果')
    const envelope = mm[1].replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;/g, "'").trim()
    assert.ok(envelope.startsWith('BBX1.'), '应当生成一段信封，实际：' + envelope.slice(0, 200))

    // 4) 贴回来：登录成功
    const loginReply = await say('/打印机 登录 ' + envelope)
    assert.match(loginReply, /登录成功/, '登录应当成功：' + loginReply)

    // 5) 能查状态
    const statusReply = await say('/打印机 状态')
    assert.match(statusReply, /42%/, '登录后应当能查到打印机状态：' + statusReply)

    // 6) 秘密不经过聊天
    const all = linkReply + '\n' + loginReply + '\n' + statusReply
    assert.equal(all.includes(PASSWORD), false, '聊天里不能出现密码')
    assert.equal(all.includes(ACCOUNT), false, '聊天里不能出现账号')
    assert.equal(all.includes('E2E-TOKEN-abcdef123456'), false, '聊天里不能出现 token')

    // 7) 一次性：重放被拒
    const replay = await say('/打印机 登录 ' + envelope)
    assert.match(replay, /已经用过/, '重放要被拒：' + replay)

    // 8) 落盘不含明文
    const files = (await readdir(dir)).sort()
    assert.ok(files.includes('bbx-key.json'), '数据目录应当有信封私钥')
    const vaultRaw = await readFile(path.join(dir, 'vault.json'), 'utf8')
    assert.equal(vaultRaw.includes('E2E-TOKEN-abcdef123456'), false, 'vault.json 不能有明文 token')
    const keyRaw = await readFile(path.join(dir, 'bbx-key.json'), 'utf8')
    assert.equal(keyRaw.includes(PASSWORD), false, '私钥文件里不能有密码')
  } finally {
    if (server) await new Promise((r) => server.close(r))
    if (ud) await rm(ud, { recursive: true, force: true })
    await rm(dir, { recursive: true, force: true })
  }
})
