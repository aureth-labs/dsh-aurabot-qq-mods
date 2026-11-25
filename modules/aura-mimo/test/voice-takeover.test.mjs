// 验证：把 aura-mimo 装成 voice 之后，是否真的接管内置语音（提供 speak 接口）
// 全程在临时目录，不碰任何真实环境。

import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, cpSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

// 模块目录 = 测试文件所在目录的上一级（相对路径，CI 和本地都能跑）
const SRC = fileURLToPath(new URL('..', import.meta.url))
const results = []
const check = (name, ok, extra = '') => { results.push({ name, ok, extra }); console.log(`${ok ? '  PASS' : '  FAIL'}  ${name}${extra ? '  [' + extra + ']' : ''}`) }

function tinyWav() {
  const n = 1600
  const buf = Buffer.alloc(44 + n)
  buf.write('RIFF', 0); buf.writeUInt32LE(36 + n, 4); buf.write('WAVE', 8)
  buf.write('fmt ', 12); buf.writeUInt32LE(16, 16); buf.writeUInt16LE(1, 20)
  buf.writeUInt16LE(1, 22); buf.writeUInt32LE(16000, 24); buf.writeUInt32LE(32000, 28)
  buf.writeUInt16LE(2, 32); buf.writeUInt16LE(16, 34); buf.write('data', 36); buf.writeUInt32LE(n, 40)
  return buf
}

let fetchCalls = 0
globalThis.fetch = async () => {
  fetchCalls++
  return new Response(JSON.stringify({
    choices: [{ message: { audio: { data: tinyWav().toString('base64') } } }],
  }), { status: 200, headers: { 'content-type': 'application/json' } })
}

/**
 * @param dirName   文件夹名（框架眼里这就是模块 id）
 * @param modJsonId module.json 里写的 id（可能被用户漏改）
 * @param viaCache  是否模拟 aurabot 的 .aurabot-cache 快照加载
 */
async function trial(dirName, modJsonId, viaCache = false) {
  const root = mkdtempSync(join(tmpdir(), 'mimo-'))
  const modDir = join(root, dirName)
  mkdirSync(modDir, { recursive: true })
  for (const f of ['index.mjs', 'panel.js', 'README.md', 'LICENSE']) cpSync(join(SRC, f), join(modDir, f))

  const mj = JSON.parse(readFileSync(join(SRC, 'module.json'), 'utf8'))
  mj.id = modJsonId
  mj.name = modJsonId
  writeFileSync(join(modDir, 'module.json'), JSON.stringify(mj, null, 2) + '\n')
  mkdirSync(join(modDir, 'assets'), { recursive: true })

  // 模拟 aurabot 的快照：<模块>/.aurabot-cache/<stamp>/ 全部文件复制一份
  let entryDir = modDir
  if (viaCache) {
    const snap = join(modDir, '.aurabot-cache', '1794230000000-001')
    mkdirSync(snap, { recursive: true })
    for (const f of ['index.mjs', 'panel.js', 'README.md', 'LICENSE', 'module.json']) {
      cpSync(join(modDir, f), join(snap, f))
    }
    mkdirSync(join(snap, 'assets'), { recursive: true })
    entryDir = snap
  }

  const dataDir = join(root, 'data')
  mkdirSync(join(dataDir, 'ref'), { recursive: true })
  writeFileSync(join(dataDir, 'ref', 'ref.mp3'), Buffer.concat([
    Buffer.from([0x49, 0x44, 0x33, 0x03, 0, 0, 0, 0, 0, 0]), Buffer.alloc(9000, 0x55),
  ]))

  const settings = {
    apiKey: 'sk-test-key', apiBase: 'https://api.xiaomimimo.com/v1',
    model: 'mimo-v2.5-tts-voiceclone', format: 'wav', refAudio: 'ref.mp3',
    timeout: '60', autoVoice: false, voiceChance: 0.3, maxChars: 60,
  }
  const routes = new Map(), hooks = new Map(), tools = []
  const api = {
    id: dirName, dir: modDir, dataDir: () => dataDir,
    settings: () => ({ ...settings }),
    saveSettings: (p) => Object.assign(settings, p),
    config: () => ({ ownerQQ: '10001', security: {} }),
    log: { info: () => {}, warn: () => {} },
    core: { http: { send: () => {}, query: () => ({}), body: async () => ({}) } },
    route: (p, fn) => routes.set(p, fn),
    tool: (fn) => tools.push(fn),
    defineTool: (t) => t,
    command: () => {}, rule: () => {},
    on: (ev, fn) => { if (!hooks.has(ev)) hooks.set(ev, []); hooks.get(ev).push(fn) },
    sendVoiceFile: async () => {}, sendText: async () => {},
  }

  const url = new URL('file:///' + join(entryDir, 'index.mjs').replace(/\\/g, '/')).href
  const mod = (await import(url)).default
  const iface = mod.setup(api)
  return { mod, iface, routes, settings }
}

console.log('=== 情况 A：文件夹 aura-mimo（日常装法）===')
{
  const a = await trial('aura-mimo', 'aura-mimo')
  check('导出 id === 文件夹名', a.mod.id === 'aura-mimo', a.mod.id)
  check('不挂 speak（不抢内置 voice）', a.iface === undefined, String(a.iface))
  check('路由照常注册', a.routes.size >= 8, a.routes.size + ' 个')
}

console.log('\n=== 情况 B：文件夹改 voice，module.json 的 id 也改了 ===')
{
  const b = await trial('voice', 'voice')
  check('导出 id === voice', b.mod.id === 'voice', b.mod.id)
  check('setup 返回接口对象', b.iface && typeof b.iface === 'object', typeof b.iface)
  check('接口里有 speak', typeof b.iface?.speak === 'function')
  if (typeof b.iface?.speak === 'function') {
    try {
      const r = await b.iface.speak('测试一下这句能不能念出来')
      check('speak 返回 file', typeof r?.file === 'string' && r.file.length > 0, r?.file?.split(/[\\/]/).pop())
      check('speak 返回 engine=mimo', r?.engine === 'mimo', r?.engine)
      const { existsSync, statSync } = await import('node:fs')
      check('合成文件存在且非空', existsSync(r.file) && statSync(r.file).size > 44, existsSync(r.file) ? statSync(r.file).size + ' 字节' : '')
    } catch (e) { check('speak 调用成功', false, e.message) }
  }
  b.settings.apiKey = ''
  try {
    await b.iface.speak('这句应该失败')
    check('没 Key 时拒绝合成', false, '居然成功了')
  } catch (e) { check('没 Key 时拒绝合成', /API Key/.test(e.message), e.message.slice(0, 30)) }
}

console.log('\n=== 情况 C：只改文件夹名，module.json 的 id 忘了改（最容易踩）===')
{
  const c = await trial('voice', 'aura-mimo')
  check('导出 id 跟随文件夹名 = voice（不看 module.json）', c.mod.id === 'voice', c.mod.id)
  check('因此能通过「id 必须等于文件夹名」的校验', c.mod.id === 'voice')
  check('speak 照样挂上了', typeof c.iface?.speak === 'function', typeof c.iface)
  console.log('  ↑ 这条是这次修的重点：漏改 module.json 也不会再导致面板消失')
}

console.log('\n=== 情况 D：aurabot 用 .aurabot-cache 快照加载（真实加载方式）===')
{
  const d = await trial('voice', 'voice', true)
  check('快照目录里也能认出 id = voice', d.mod.id === 'voice', d.mod.id)
  check('快照加载时 speak 也在', typeof d.iface?.speak === 'function', typeof d.iface)
}

console.log('\n=== 情况 E：快照加载 + module.json 漏改 ===')
{
  const e = await trial('voice', 'aura-mimo', true)
  check('依然认得出 voice', e.mod.id === 'voice', e.mod.id)
  check('依然挂上 speak', typeof e.iface?.speak === 'function', typeof e.iface)
}

const pass = results.filter((r) => r.ok).length
console.log(`\n合计 ${pass} 通过 / ${results.length - pass} 失败    (fetch 调用 ${fetchCalls} 次)`)
if (pass !== results.length) process.exit(1)
