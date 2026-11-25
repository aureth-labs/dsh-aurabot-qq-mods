// 面板集成：目的引擎 / 桌宠的 /panel/* 代理与 /state 聚合。
// fake-dsh 模式；AURABOT_DATA_DIR 隔离；不引入新依赖。
// purpose 是默认关的独立模块：这里验证「没开时面板不炸、打开后接口可用」的降级语义。
import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, unlinkSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { cpSync } from 'node:fs'
import { pathToFileURL, fileURLToPath } from 'node:url'
const PLUGIN = process.env.AURABOT_PLUGIN_DIR
const fromPlugin = (p) => import(pathToFileURL(join(PLUGIN, p)).href)
const installPet = (dataDir) => cpSync(fileURLToPath(new URL('../', import.meta.url)), join(dataDir, 'modules', 'pet'), { recursive: true, filter: (f) => !/[\\/]test([\\/]|$)/.test(f.slice(fileURLToPath(new URL('../', import.meta.url)).length - 1)) })
const { startMockOneBot } = await fromPlugin('test/helpers/mock-onebot.js')
const { createFakeDsh } = await fromPlugin('test/helpers/fake-dsh.js')

const OWNER = '10000001'
const BOT = '20000002'
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

async function brain() { await sleep(1); return '嗯' }

const call = async (path, body) => (await fake.call(path, body)).json()

let mock
let fake
let api
let dataDir

before(async () => {
  dataDir = mkdtempSync(join(tmpdir(), 'aurabot-panel-'))
  process.env.AURABOT_DATA_DIR = dataDir
  process.env.AURABOT_WORKSPACE = join(dataDir, 'ws')
  mkdirSync(join(dataDir, 'ws'), { recursive: true })
  installPet(dataDir)
  mock = await startMockOneBot({ selfId: BOT })
  writeFileSync(join(dataDir, 'config.json'), JSON.stringify({
    enabled: true,
    dryRun: false,
    setupDone: true,
    botQQ: BOT,
    ownerQQ: OWNER,
    allow: { private: [OWNER], groups: [] },
    snowluma: { autoStart: false, autoAttach: false, httpUrl: mock.httpUrl, wsUrl: mock.wsUrl, httpToken: mock.token, wsToken: mock.token, dir: join(dataDir, 'no-snowluma') },
    voice: { engine: 'windows', autoChance: 0 },
    stickers: { autoChance: 0 },
    bridge: { dshTools: false, http: true, token: 'a'.repeat(32) },
    // 目的引擎 1.3.0 起缺省是开的（ext.purpose.enabled 缺省=开）；这里显式关掉，
    // 验的还是「关掉时面板不炸」的降级语义，不依赖上游默认值。
    ext: { purpose: { enabled: false } },
  }))
  fake = createFakeDsh({ brain })
  // DSH 的 webServer 服务带真实端口（真机同理）：host.js 靠它给 pet 模块注入端口、破「host.json 写 :0」的自举死锁
  fake.ctx.webServer.port = 5099
  const host = await fromPlugin('src/host.js')
  api = host.apply(fake.ctx)
  await api.ready.catch(() => {})
  await fake.call('/onebot/reconnect')
})

after(async () => {
  fake?.dispose()
  await mock?.close()
  setTimeout(() => process.exit(0), 200).unref()
})

const sentToOwner = () => mock.calls.filter((c) => c.action === 'send_private_msg' && String(c.params.user_id) === OWNER)

test('/state 聚合 purpose 字段（显式关掉也不炸）', async () => {
  const st = await call('/state')
  assert.equal(st.ok, true)
  // 概览页要的 speakUp.count 必须还在（speakup 模块保持默认实现，不受影响）
  assert.equal(typeof st.speakUp.count, 'number')
  assert.ok(st.purpose, 'purpose 聚合字段存在')
  assert.equal(st.purpose.available, true, 'purpose 模块已提供 status()')
  assert.equal(st.purpose.enabled, false, '显式关掉目的引擎')
  assert.equal(st.purpose.pacing, 'default')
  assert.equal(st.purpose.dailyMax, 20, 'dailyMax 取自 speakUp.maxPerDay 默认值（1.2.0 起是 20，上游 f41ea37）')
  assert.equal(st.purpose.quietStart, '23:00', '安静时段由醒着窗口 8~23 推算')
  assert.equal(st.purpose.quietEnd, '08:00')
  assert.ok(st.pet && typeof st.pet.online === 'boolean', 'pet 已是内置模块：/state 聚合桌宠状态卡')
  // token 脱敏：32 位 bridge token 不出现在任何返回里
  assert.ok(!JSON.stringify(st).includes('a'.repeat(32)), 'state 返回不得出现 32 位令牌明文')
})

test('面板代理 /panel/purpose/status：聚合 purpose + pet，token 已脱敏', async () => {
  const r = await call('/panel/purpose/status')
  assert.equal(r.ok, true)
  assert.equal(r.purpose.available, true)
  assert.equal(r.purpose.enabled, false)
  assert.ok(r.pet && typeof r.pet.online === 'boolean', 'pet 已内置：/panel/purpose/status 聚合桌宠状态')
  assert.ok(!JSON.stringify(r).includes('a'.repeat(32)))
})

test('开关与调参透传：/panel/purpose/config 写 ext.purpose.*，醒着窗口写 speakUp.*', async () => {
  const r = await call('/panel/purpose/config', { enabled: true, carrier: 'pet', petFallbackToQQ: false, pacing: 'conservative', awakeFrom: 9, awakeTo: 22, maxPerDay: 2 })
  assert.equal(r.ok, true)
  assert.equal(r.purpose.enabled, true)
  assert.equal(r.purpose.carrier, 'pet')
  assert.equal(r.purpose.petFallbackToQQ, false)
  assert.equal(r.purpose.pacing, 'conservative')
  assert.equal(r.purpose.awakeFrom, 9)
  assert.equal(r.purpose.awakeTo, 22)
  assert.equal(r.purpose.quietStart, '22:00', '安静时段随醒着窗口重推')
  assert.equal(r.purpose.quietEnd, '09:00')
  assert.equal(r.purpose.dailyMax, 2)
  // 落盘位置：引擎开关/载体进 ext.purpose，醒着窗口/每日上限进 speakUp（保持单一真相）
  const saved = JSON.parse(readFileSync(join(dataDir, 'config.json'), 'utf8'))
  assert.equal(saved.ext.purpose.enabled, true)
  assert.equal(saved.ext.purpose.pacing, 'conservative')
  assert.equal(saved.ext.purpose.carrier, 'pet')
  assert.equal(saved.speakUp.awakeFrom, 9)
  // 透传到 /state（面板另一处数据源一致）
  const st = await call('/state')
  assert.equal(st.purpose.enabled, true)
  assert.equal(st.purpose.carrier, 'pet')
  // 非法字段拒绝
  const bad = await call('/panel/purpose/config', { carrier: 'wechat' })
  assert.equal(bad.ok, false)
  // 关回去，不污染别的用例
  const back = await call('/panel/purpose/config', { enabled: false, carrier: 'qq', petFallbackToQQ: true, pacing: 'default' })
  assert.equal(back.ok, true)
  assert.equal(back.purpose.enabled, false)
  assert.equal(back.purpose.carrier, 'qq')
})

test('预览零副作用：/panel/purpose/preview 收素材拼提示词，但不发 QQ', async () => {
  const before = sentToOwner().length
  const r = await call('/panel/purpose/preview')
  assert.equal(r.ok, true)
  assert.ok(r.result, '有预览结果')
  assert.ok(r.result.stats, '预览含素材统计：' + JSON.stringify(r).slice(0, 400))
  assert.ok(Array.isArray(r.result.materials), '预览含素材列表')
  assert.ok(!JSON.stringify(r).includes('a'.repeat(32)), '预览返回不得出现 32 位令牌明文')
  await sleep(50)
  assert.equal(sentToOwner().length, before, '预览不得向 QQ 发送任何消息')
})

test('手动试跑：引擎关着时明确拒绝；打开后能真跑一轮并投递私聊', async () => {
  const r0 = await call('/panel/purpose/run')
  assert.equal(r0.ok, false, '默认关：run 明确报「开关是关的」')
  assert.match(String(r0.message || ''), /开关/)
  const on = await call('/panel/purpose/config', { enabled: true })
  assert.equal(on.ok, true)
  const before = sentToOwner().length
  const r = await call('/panel/purpose/run')
  assert.equal(r.ok, true, JSON.stringify(r))
  assert.equal(sentToOwner().length, before + 1, '真跑一轮：私聊里多发了一条')
  await call('/panel/purpose/config', { enabled: false })
})

// ---------- 桌宠（pet 模块与面板代理） ----------

test('桌宠端口注入：宿主把 webServer 端口写进 host.json（破自举死锁），status 报 portReady', async () => {
  const hostFile = join(dataDir, 'modules-data', 'pet', 'host.json')
  const h = JSON.parse(readFileSync(hostFile, 'utf8'))
  assert.equal(h.baseUrl, 'http://127.0.0.1:5099', 'baseUrl 来自 ctx.webServer.port 注入，不再是 :0/null')
  const st = await call('/panel/pet/status')
  assert.equal(st.pet.portReady, true, 'status 报端口就绪')
  assert.equal(st.pet.port, 5099)
  assert.equal(st.pet.electronInstalled, false, '初始状态：Electron 未装')
  assert.equal(st.pet.pid, null, '初始状态：没有运行中的桌宠进程')
})

test('Electron 三键代理：未装客户端/未装 Electron/无进程记录时全部降级，不炸也不 spawn', async () => {
  // 清掉 app/main.js（若前面的 download 用例已生成），保证「还没生成客户端」的前置成立
  const appMain = join(dataDir, 'modules-data', 'pet', 'app', 'main.js')
  if (existsSync(appMain)) { try { unlinkSync(appMain) } catch {} }
  const ei = await call('/panel/pet/electron-install', {})
  assert.equal(ei.ok, true, '代理通')
  assert.equal(ei.result.ok, false, '还没生成客户端：electron-install 降级报错')
  assert.match(ei.result.message, /客户端/)
  const la = await call('/panel/pet/launch', {})
  assert.equal(la.ok, true)
  assert.equal(la.result.ok, false, 'Electron 没装：launch 降级报错')
  const sp = await call('/panel/pet/stop', {})
  assert.equal(sp.ok, true)
  assert.equal(sp.result.ok, false, '没有进程记录：stop 降级报错')
  assert.ok(!JSON.stringify(ei).includes('a'.repeat(32)), '三键返回也脱敏')
})

test('桌宠面板代理：pet 已是内置模块，status/download/focus 三个代理都工作（api.use 前缀无关）', async () => {
  const st = await call('/panel/pet/status')
  assert.equal(st.ok, true)
  assert.ok(st.pet && typeof st.pet.online === 'boolean', '内置 pet 在跑：status 状态卡（扁平结构，online 布尔）')
  const dl = await call('/panel/pet/download', {})
  assert.equal(dl.ok, true, 'download 代理走 pet.download()（installClient）')
  assert.equal(dl.result.ok, true)
  assert.ok(Array.isArray(dl.result.files) && dl.result.files.length > 0, '客户端模板已生成到数据目录')
  const fc = await call('/panel/pet/focus', { enabled: true })
  assert.equal(fc.ok, true)
  assert.equal(fc.result.enabled, true, 'focus 代理走 pet.setFocus()')
  const st2 = await call('/panel/pet/status')
  assert.equal(st2.pet.focus, true, 'status 回读专注状态')
})

test('桌宠面板设置：/panel/pet/config 写 ext.pet.*（碎碎念节奏/文案池/干活提醒），status 能读回', async () => {
  const before = (await call('/panel/pet/status')).pet
  assert.ok(before.whisper, 'status 要带碎碎念状态（面板设置卡靠它渲染）')
  assert.equal(typeof before.whisper.enabled, 'boolean')
  assert.equal(before.workEnabled, true, '干活状态动画默认开')
  const r = await call('/panel/pet/config', {
    whisperEnabled: false, whisperMinMinutes: 10, whisperMaxMinutes: 20, whisperMaxPerDay: 2,
    whisperLines: '（自己写的）\n（第二句）', whisperPauseOnPetCarrier: false,
    workStatusEnabled: false, workBubble: false, workNotify: false,
  })
  assert.equal(r.ok, true, JSON.stringify(r))
  const after = r.pet
  assert.equal(after.whisper.enabled, false)
  assert.equal(after.whisper.minMinutes, 10)
  assert.equal(after.whisper.maxMinutes, 20)
  assert.equal(after.whisper.maxPerDay, 2)
  assert.match(after.whisper.lines, /自己写的/)
  assert.equal(after.workEnabled, false)
  assert.equal(after.workBubble, false)
  assert.equal(after.workNotify, false, '完工通知开关要落盘')
  const saved = JSON.parse(readFileSync(join(dataDir, 'config.json'), 'utf8'))
  assert.equal(saved.ext.pet.whisperMinMinutes, 10)
  assert.equal(saved.ext.pet.whisperLines.split('\n').length, 2)
  // 没有可保存字段：明确拒绝，不静默成功
  const empty = await call('/panel/pet/config', { foo: 1 })
  assert.equal(empty.ok, false)
})

test('桌宠面板：/panel/pet/whisper 在桌宠没跑时明确降级（不抛错、不说发成功）', async () => {
  const r = await call('/panel/pet/whisper', {})
  assert.equal(r.ok, false)
  assert.match(String(r.message || ''), /桌宠|专注|总开关/)
})
