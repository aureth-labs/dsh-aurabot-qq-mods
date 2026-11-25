// test/enroll-page.test.mjs —— GitHub Pages 静态页的静态检查 + 真浏览器（可选）端到端。
//
// 两层：
//   1. 静态检查（永远跑）：页面不许有远程资源、不许本地存储、脚本能按 ES module 解析、
//      必须从 hash 取公钥、必须把「只在私聊发」写出来；
//   2. 真浏览器（只有本机装了 Edge/Chrome 才跑）：用 headless 浏览器打开页面、填表、点生成，
//      拿到 BBX1 文本后在本进程用真实私钥解开，确认「浏览器 → 机器人」这条链路真的通。
//      浏览器不在的机器上跳过，不会让 CI 变红。
import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { execFile } from 'node:child_process'
import { createServer } from 'node:http'
import { promisify } from 'node:util'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { createEnvelopeService } from '../lib/envelope.mjs'

const run = promisify(execFile)
const HERE = path.dirname(fileURLToPath(import.meta.url))
// E2E 包装页的虚拟文件名：请求路径和内存里那份的键必须用同一个常量，
// 否则 '/.__e2e__.html' 会被解析成 '.__e2e__.html'（前导点）而 map 里是 '__e2e__.html'，直接 404。
const E2E_PAGE = 'e2e-page.html'
const ENROLL_DIR = path.join(HERE, '..', 'assets', 'enroll')
const INDEX = path.join(ENROLL_DIR, 'index.html')

const readIndex = async () => readFile(INDEX, 'utf8')

test('页面：只用同目录资源，没有任何远程依赖', async () => {
  const html = await readIndex()
  // 不引用外部域名（脚本 / 样式 / 字体 / 图片）
  const srcs = [...html.matchAll(/(?:src|href)\s*=\s*["']([^"']+)["']/g)].map((m) => m[1])
  for (const src of srcs) {
    assert.doesNotMatch(src, /^(https?:)?\/\//, '不许引用远程资源：' + src)
    assert.match(src, /^\.\/[\w.-]+\.[a-z]+$/, '资源要写成同目录相对路径：' + src)
  }
  // 没有 fetch / XHR / WebSocket / sendBeacon：页面本身不联网
  for (const pattern of [/\bfetch\s*\(/, /XMLHttpRequest/, /new\s+WebSocket/, /sendBeacon/, /importScripts/]) {
    assert.doesNotMatch(html, pattern, '页面不该联网：' + pattern)
  }
})

test('页面：不使用任何本地存储（关掉/刷新就丢）', async () => {
  const html = await readIndex()
  for (const pattern of [/localStorage/, /sessionStorage/, /document\.cookie/, /indexedDB/]) {
    assert.doesNotMatch(html, pattern, '页面不该把输入留在本机：' + pattern)
  }
  const form = await readFile(path.join(ENROLL_DIR, 'enroll-form.js'), 'utf8')
  const bbx = await readFile(path.join(ENROLL_DIR, 'bbx.js'), 'utf8')
  for (const pattern of [/localStorage/, /sessionStorage/, /document\.cookie/]) {
    assert.doesNotMatch(form, pattern)
    assert.doesNotMatch(bbx, pattern)
  }
})

test('页面：内联脚本能按 ES module 解析（曾经因为 boot 漏了 async 直接白屏）', async () => {
  const html = await readIndex()
  const start = html.indexOf('<script type="module">')
  assert.ok(start > 0, '页面应当有一个 type="module" 的脚本')
  const from = start + '<script type="module">'.length
  const to = html.indexOf('</script>', from)
  const code = html.slice(from, to)
  const dir = await mkdtemp(path.join(os.tmpdir(), 'bambu-page-'))
  const file = path.join(dir, 'page.mjs')
  try {
    await writeFile(file, code, 'utf8')
    // --check 只是语法解析，不执行（页面里有 location / document）
    await run(process.execPath, ['--check', file])
    // boot 必须是 async：里面有 await import
    assert.match(code, /async function boot\s*\(/)
  } finally { await rm(dir, { recursive: true, force: true }) }
})

test('页面：从 URL 的 #k= 取公钥（含 ?k= 兜底和整条链接粘贴）', async () => {
  const html = await readIndex()
  assert.match(html, /location\.hash/, '要从 hash 取公钥：hash 不会发给服务器')
  assert.match(html, /URLSearchParams/, '要能解析 k= 参数')
  assert.match(html, /#k=/, '页面文案要告诉用户链接里的 #k= 就是公钥')
  // 允许手动粘贴整条链接
  assert.match(html, /manual-key/, '要有手动粘贴公钥的入口')
  assert.match(html, /87/, '要说明公钥是 87 个字符')
})

test('页面：把「只在私聊发、别发群里」写在结果区', async () => {
  const html = await readIndex()
  const resultAt = html.indexOf('id="result"')
  assert.ok(resultAt > 0, '要有结果区')
  const resultBlock = html.slice(resultAt, resultAt + 2000)
  assert.match(resultBlock, /私聊/, '结果区必须说明只在私聊发')
  assert.match(resultBlock, /不要发群里|别发群里/, '结果区必须说明不要发群里')
  assert.match(resultBlock, /一次/, '结果区必须说明只能用一次')
})

test('页面：区域下拉由 enroll-form.js 生成，默认值只有一处真相', async () => {
  const html = await readIndex()
  // markup 里不要写死选项（否则和 REGION_OPTIONS 会各写一份、改一处忘另一处）
  assert.doesNotMatch(html, /<option[^>]*value="(?:us|eu|cn)"/, '<option> 应当由 REGION_OPTIONS 生成，不要写死在 markup 里')
  assert.match(html, /REGION_OPTIONS/, '要按 REGION_OPTIONS 生成下拉')
  assert.match(html, /DEFAULT_REGION/, '默认值要跟 DEFAULT_REGION 走')
  const form = await readFile(path.join(ENROLL_DIR, 'enroll-form.js'), 'utf8')
  assert.match(form, /DEFAULT_REGION = 'cn'/, '默认区域是中国大陆')
})

test('页面：bbx.js 是唯一加解密实现，不重复实现一套', async () => {
  const bbx = await readFile(path.join(ENROLL_DIR, 'bbx.js'), 'utf8')
  // 页面只 import bbx.js / enroll-form.js，不自己写 crypto.subtle 之外的加密流程
  const html = await readIndex()
  const imports = [...html.matchAll(/import\s*\(\s*['"]([^'"]+)['"]\s*\)/g)].map((m) => m[1])
  for (const spec of imports) assert.match(spec, /^\.\/(bbx|enroll-form)\.js$/, '只许 import 同目录的 bbx.js / enroll-form.js：' + spec)
  // bbx.js 必须用 PA-256 ECDH + HKDF-SHA256 + AES-256-GCM
  assert.match(bbx, /ECDH/)
  assert.match(bbx, /P-256/)
  assert.match(bbx, /HKDF/)
  assert.match(bbx, /AES-GCM/)
  assert.match(bbx, /bambu-print\/envelope\/v1/)
})

test('页面：只有「登录」一种用途，账号密码必填，没有安全码字段', async () => {
  const form = await import('../assets/enroll/enroll-form.js')
  const html = await readIndex()

  // 页面上不该再有安全码 / 新安全码输入框
  assert.doesNotMatch(html, /id="code"/, '不该再有安全码输入框')
  assert.doesNotMatch(html, /id="newcode"/, '不该再有新安全码输入框')
  assert.doesNotMatch(html, /安全码/, '页面正文不该再提安全码')

  // 账号密码必填
  const empty = form.validateInputs({ ttlMin: 10 })
  assert.equal(empty.ok, false, '什么都不填不该能生成')
  assert.match(empty.errors.join('；'), /账号和密码/)
  const login = form.validateInputs({ account: 'a@b.com', password: 'pw', ttlMin: 10 })
  assert.equal(login.ok, true, '登录表单应当合法：' + login.errors.join('；'))
  assert.equal(login.kind, 'login')
})

test('页面：生存时间固定 10 分钟，不再有设置窗口；区域可选且默认中国', async () => {
  const html = await readIndex()
  // 生存时间不再给用户填
  assert.doesNotMatch(html, /id="ttl"/, '不该再有生存时间输入框')
  assert.match(html, /FIXED_TTL_MIN = 10/, '生存时间要固定成 10 分钟')
  // 区域保留选择
  assert.match(html, /id="region"/, '区域要能选')
  const form = await import('../assets/enroll/enroll-form.js')
  assert.equal(form.DEFAULT_REGION, 'cn', '默认中国大陆')
  assert.ok(form.REGION_OPTIONS.length >= 2, '至少给出国服以外的选项')

  // 真跑一次：不传 ttl 也要落成 10 分钟
  const payload = form.buildPayload({ account: 'a@b.com', password: 'pw' })
  assert.equal(payload.ttlMin, 10)
  assert.equal(payload.exp - payload.iat, 600, '10 分钟 = 600 秒')
})

test('页面：结构符合最终形态（无用途卡片、主按钮是复制整条命令、hidden 真的生效）', async () => {
  const html = await readIndex()
  const css = await readFile(path.join(ENROLL_DIR, 'style.css'), 'utf8')

  // 「这段是用来做什么的」整块已删除
  assert.doesNotMatch(html, /这段是用来做什么的/, '不该再有用途说明卡片')
  assert.doesNotMatch(html, /id="uses-card"/)
  // 旧的「三种用法」文案也清掉了
  assert.doesNotMatch(html, /三种用法/, '不该再提三种用法')

  // 主按钮是「复制整条命令」，次要按钮是「只复制密文」
  const primary = html.indexOf('class="primary" id="copy-command"')
  const secondary = html.indexOf('class="secondary" id="copy"')
  assert.ok(primary > 0, '主按钮应当是「复制整条命令」')
  assert.ok(secondary > 0, '次要按钮应当是「只复制密文」')
  assert.ok(primary < secondary, '主按钮要排在前面')

  // .card 的 display:flex 会盖掉 [hidden]，CSS 必须显式补一条
  assert.match(css, /\[hidden\]\s*\{[^}]*display:\s*none\s*!important/, 'CSS 要显式处理 [hidden]')
  // 结果区默认隐藏
  assert.match(html, /<section class="card result" id="result" hidden>/)

  // 复制按钮在空文本框时置灰 + 空白时不报「复制失败」
  assert.match(html, /function syncCopyButtons/, '要有按钮置灰逻辑')
  assert.match(html, /还没有生成内容/, '空内容要给明确提示')
  // 注释里可以提这个词，但 showCopied() 的实参里不能出现「复制失败」
  const shown = [...html.matchAll(/showCopied\(([^)]*)\)/g)].map((m) => m[1]).join('\n')
  assert.ok(!shown.includes('复制失败'), '用户可见提示里不该说「复制失败」：' + shown);

  // 刚打开页面不该先报错
  assert.match(html, /showErrors = state\.touched/, '未触碰表单时不显示错误')
})

// ------------------------------------------------------------------ 真浏览器端到端（可选）

function findBrowser () {
  const candidates = [
    process.env.BAMBU_TEST_BROWSER,
    'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
    'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
    'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
    'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
    '/usr/bin/google-chrome',
    '/usr/bin/chromium',
    '/usr/bin/chromium-browser',
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  ].filter(Boolean)
  return candidates.find((p) => existsSync(p)) || ''
}

/**
 * CI 的 ubuntu runner 上没有桌面环境：Chrome 进程能起、也能退出，但 --dump-dom
 * 一个字节都不往 stdout 写（同样的参数在本机 Windows 上是好的）。这条端到端
 * 只依赖真浏览器，环境不对就给不出信号，所以 CI 里默认不跑；要强制跑就显式设
 * BAMBU_TEST_BROWSER 指向浏览器。
 */
function browserE2eAllowed () {
  if (process.env.BAMBU_TEST_BROWSER) return true
  return !/^(1|true|yes)$/i.test(String(process.env.CI || ''))
}

/**
 * 起一个只读静态服务，把 assets/enroll/ 原样发出去。
 * extra 里的条目只存在于内存（E2E 的包装页），**绝不写进 assets/enroll/**——
 * 那个目录原样发布到 GitHub Pages，测试产物落进去就会被一起发布出去。
 */
async function serveEnroll (extra = {}) {
  const server = createServer(async (req, res) => {
    const url = new URL(req.url, 'http://127.0.0.1')
    const name = url.pathname === '/' ? 'index.html' : url.pathname.replace(/^\//, '')
    if (Object.hasOwn(extra, name)) {
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
      res.end(extra[name])
      return
    }
    if (!/^[\w.-]+$/.test(name)) { res.writeHead(400); res.end(); return }
    try {
      const body = await readFile(path.join(ENROLL_DIR, name))
      const type = name.endsWith('.html') ? 'text/html; charset=utf-8'
        : name.endsWith('.js') ? 'text/javascript; charset=utf-8'
          : name.endsWith('.css') ? 'text/css; charset=utf-8' : 'application/octet-stream'
      res.writeHead(200, { 'content-type': type })
      res.end(body)
    } catch {
      res.writeHead(404); res.end()
    }
  })
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  const { port } = server.address()
  return { server, origin: 'http://127.0.0.1:' + port, close: () => new Promise((r) => server.close(r)) }
}

/**
 * 在真浏览器里跑一段脚本，把结果从 DOM 里取回来。
 * 只依赖 --headless=new --dump-dom，不需要 puppeteer。
 */
async function runInBrowser (browser, url, { timeoutMs = 25000 } = {}) {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'bambu-chrome-'))
  try {
    const { stdout, stderr } = await run(browser, [
      '--headless=new', '--disable-gpu', '--no-sandbox', '--no-first-run',
      '--disable-dev-shm-usage', '--virtual-time-budget=8000',
      '--user-data-dir=' + dir,
      '--dump-dom', url,
    ], { timeout: timeoutMs, maxBuffer: 8 * 1024 * 1024 })
    // 有的 Edge 版本 --dump-dom 会把头几个字节吞掉/混入日志，这里只保留 <!doctype 之后的部分
    if (!stdout) throw new Error('浏览器没有输出（stderr：' + String(stderr || '').slice(0, 1200) + '）')
    return stdout
  } finally { await rm(dir, { recursive: true, force: true }) }
}

test('真浏览器：在页面里生成信封，本进程能解开（浏览器 → 机器人 全链路）', async (t) => {
  const browser = findBrowser()
  if (!browser || !browserE2eAllowed()) {
    t.skip(browser
      ? 'CI 里没有桌面环境（Chrome --dump-dom 不输出），真浏览器端到端只在本地跑；要强制跑请设 BAMBU_TEST_BROWSER'
      : '本机没有 Edge/Chrome，跳过真浏览器端到端（设 BAMBU_TEST_BROWSER 可指定路径）')
    return
  }
  const dir = await mkdtemp(path.join(os.tmpdir(), 'bambu-e2e-'))
  const web = await serveEnroll()
  try {
    const service = createEnvelopeService({ dir, log: { info () {}, warn () {}, error () {}, debug () {} } })
    await service.ensure()
    const pub = service.publicKey()

    // 「测试用包装页」在 iframe 里加载真页面，并在 load 后驱动表单（页面本身不用改动）。
    // 包装页只存在于内存里，通过上面那个静态服务的 extra 提供。
    const wrapper = e2eWrapper(pub)
    const web2 = await serveEnroll({ [E2E_PAGE]: wrapper })
    try {
      const dom = await runInBrowser(browser, web2.origin + '/' + E2E_PAGE)
      const match = dom.match(/<pre id="out">([^<]*)<\/pre>/)
      assert.ok(match, '浏览器没有把生成结果写回来（DOM 长度 ' + dom.length + '）：' + dom.slice(0, 600))
      const text = decodeEntities(match[1]).trim()
      assert.ok(!text.startsWith('ERR'), '页面里出错了：' + text)
      assert.match(text, /^BBX1\./, '浏览器生成的应当是一段 BBX1 信封：' + text.slice(0, 80))

      const opened = await service.open(text)
      assert.equal(opened.kind, 'login')
      assert.equal(Object.hasOwn(opened, 'code'), false, '信封里不再有安全码这个字段')
      assert.equal(opened.account, 'me@example.com')
      assert.equal(opened.password, 'pw-e2e-123')
      assert.equal(opened.region, 'cn', '网页默认区域应当是中国大陆')
      assert.equal(opened.ttlMin, 10, '网页固定 10 分钟生存时间')
    } finally {
      await web2.close()
    }
    // 断言测试没有在发布目录里留下东西
    assert.equal(existsSync(path.join(ENROLL_DIR, E2E_PAGE)), false, '测试产物不能落在 assets/enroll/')
  } finally {
    await web.close()
    await rm(dir, { recursive: true, force: true })
  }
})

function decodeEntities (text) {
  return String(text)
    .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'").replace(/&amp;/g, '&')
}

/** iframe 包装页：加载真页面，等它 ready 之后填表、点生成、把结果写进 <pre id="out">。 */
function e2eWrapper (pub) {
  return '<!doctype html><html><head><meta charset="utf-8"></head><body>' +
    '<iframe id="f" src="./index.html#k=' + pub + '" style="width:900px;height:1200px"></iframe>' +
    '<pre id="out"></pre>' +
    '<script>' +
    'const f = document.getElementById("f");' +
    'const out = document.getElementById("out");' +
    'function fail(msg) { out.textContent = "ERR: " + msg; }' +
    'f.addEventListener("load", function () {' +
    '  const w = f.contentWindow, d = f.contentDocument;' +
    '  const t0 = Date.now();' +
    '  const tick = function () {' +
    '    const btn = d.getElementById("generate");' +
    '    const code = d.getElementById("code");' +
    '    if (!btn || btn.disabled) {' +
    '      if (Date.now() - t0 > 12000) return fail("公钥没载入：" + (d.body ? d.body.innerText.slice(0, 200) : "?"));' +
    '      return setTimeout(tick, 100);' +
    '    }' +
    '    const set = function (id, v) {' +
    '      const el = d.getElementById(id);' +
    '      el.value = v;' +
    '      el.dispatchEvent(new w.Event("input", { bubbles: true }));' +
    '    };' +
    '    set("account", "me@example.com");' +
    '    set("password", "pw-e2e-123");' +
    '    d.getElementById("form").dispatchEvent(new w.Event("submit", { bubbles: true, cancelable: true }));' +
    '    const wait = function () {' +
    '      const res = d.getElementById("result");' +
    '      const text = d.getElementById("output").value;' +
    '      if (res && !res.hidden && text) { out.textContent = text; return; }' +
    '      if (Date.now() - t0 > 15000) {' +
    '        const issues = d.getElementById("issues");' +
    '        return fail("没生成：" + (issues ? issues.innerText : "?"));' +
    '      }' +
    '      setTimeout(wait, 100);' +
    '    };' +
    '    wait();' +
    '  };' +
    '  setTimeout(tick, 100);' +
    '});' +
    '</script></body></html>'
}
