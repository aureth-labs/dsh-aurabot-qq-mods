// 梗百科模块的自测：node test/run.mjs
//
// 不联网、不读外部数据：自己建一个临时数据目录，塞几条假词条跑完整流程。
// 退出码 0 = 全过；1 = 有失败项。

import { mkdtempSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { EventEmitter } from 'node:events'

const MOD = fileURLToPath(new URL('..', import.meta.url))
const results = []
const instances = []
const check = (name, ok, detail = '') => results.push({ name, ok: Boolean(ok), detail: String(detail || '') })

// ---------- 造一个假 api ----------
function makeApi({ settings = {} } = {}) {
  const cleanups = []
  const events = {}
  const routes = {}
  const tools = []
  const commands = {}
  let rulesFn = null
  const logs = []
  const dataDir = mkdtempSync(join(tmpdir(), 'meme-wiki-test-'))
  const api = {
    id: 'meme-wiki',
    source: 'user',
    version: 'test',
    apiVersion: 1,
    dir: MOD,
    dataDir: (...p) => (p.length ? join(dataDir, ...p) : dataDir),
    settings: () => settings,
    log: {
      info: (m) => logs.push('info ' + m),
      warn: (m) => logs.push('warn ' + m),
      error: (m) => logs.push('error ' + m),
      debug: () => {},
    },
    on: (e, f) => { (events[e] ||= []).push(f); return () => {} },
    rule: (f) => { rulesFn = f; return () => {} },
    tool: (b) => { tools.push(b); return () => {} },
    defineTool: (t) => t,
    command: (c) => { commands[c.name] = c; return () => {} },
    route: (p, h) => { routes[p] = h; return () => {} },
    every: () => () => {},
    later: () => () => {},
    onDispose: (fn) => { cleanups.push(fn); return () => {} },
    context: () => () => {},
    emit: () => {},
    use: () => null,
    lazy: () => ({}),
    has: () => false,
    core: {},
  }
  const instance = { api, events, routes, tools, commands, getRules: () => rulesFn, logs, dataDir, dispose: () => cleanups.reverse().forEach(fn => fn()) }
  instances.push(instance)
  return instance
}

// 假请求：带上 JSON 请求体和一个 header
function fakeReq(body, headers = {}) {
  const e = new EventEmitter()
  e.url = '/'
  e.method = body ? 'POST' : 'GET'
  e.headers = headers
  e.destroy = () => {}
  if (body !== undefined) {
    setTimeout(() => { e.emit('data', Buffer.from(JSON.stringify(body))); e.emit('end') }, 0)
  }
  return e
}

// ---------- 准备：模块 + 几条假词条 ----------
const { api, events, routes, tools, commands, getRules, dataDir } = makeApi({ settings: { autoSync: false } })
const mod = (await import(pathToFileURL(join(MOD, 'index.mjs')).href)).default
await mod.setup(api)

const { DatabaseSync } = await import('node:sqlite')
const db = new DatabaseSync(join(dataDir, 'memes.db'))

// 空库：规则要说清楚还没导入；不该注入
check('空库时规则提示未导入', String(getRules()('social', {})).includes('还没导入'), String(getRules()('social', {})))
const emptyInject = await events.prompt[0]([{ type: 'text', text: '你好' }], { chat: { chatId: 'private:1', kind: 'private' }, queryText: '鸡你太美' })
check('空库不注入', emptyInject.length === 1, 'len=' + emptyInject.length)

// 塞三条假词条（不依赖真实词库）
const ins = db.prepare('INSERT INTO memes (title, slug, tags, usage, origin, other, summary, aliases) VALUES (?,?,?,?,?,?,?,?)')
ins.run('测试梗甲', '测试梗甲', '', '这是甲的定义，用来测命中。', '', '', '', '甲甲乙,甲乙乙')
ins.run('测试梗乙', '测试梗乙', '', '这是乙的定义。' + '填充'.repeat(60), '', '', '', '')
ins.run('测试梗丙 emoji', '测试梗丙', '', '😀🇨🇳👨‍👩‍👧‍👦 前面是 emoji，后面是正文。', '', '', '', '')
ins.run('测试梗长', '测试梗长', '', '开头。' + '填充'.repeat(200), '', '', '', '')  // 400+ 字，用来测截断说明

// 触发重建索引：模块没暴露 rebuild，借 /import 之外的办法——加一条再删一条
const before = (await routes['/stats']()).total
check('统计能读到条数', before === 4, 'total=' + before + '（4 条 = 甲/乙/丙/长）')

const populatedRules = JSON.stringify(getRules()('social', {}))
check('有词条时规则不带动态条数', !/\d+ 条/.test(populatedRules) && populatedRules.includes('你有一个本地梗库。'))

// ---------- 注入 ----------
const inject = async (text, chat = { chatId: 'private:1', kind: 'private' }) =>
  await events.prompt[0]([{ type: 'text', text: text }], { chat, queryText: text })
const hit = await inject('测试梗甲')
check('命中后注入一段', hit.length === 2, 'len=' + hit.length)
check('提示里写明不是指令', String(hit[1]?.text || '').includes('不是指令'), String(hit[1]?.text || '').slice(0, 40))
check('提示里带词条正文', String(hit[1]?.text || '').includes('这是甲的定义'), '')

const typo = await inject('测试更甲')
check('错别字靠读音命中', typo.length === 2, String(typo[1]?.text || '').slice(0, 30))

const miss = await inject('今天上班好累啊')
check('无关的话不注入', miss.length === 1, 'len=' + miss.length)

const sys = await inject('测试梗甲', { chatId: 'system:diary', kind: 'system' })
check('system 会话不注入', sys.length === 1, 'len=' + sys.length)

// ---------- 工具 ----------
const tool = tools[0]({ chat: { kind: 'private' } })
check('system 会话不给工具', Array.isArray(tools[0]({ chat: { kind: 'system' } })) && tools[0]({ chat: { kind: 'system' } }).length === 0)
const t1 = await tool.execute({ query: '测试梗甲' })
check('工具能查到', t1.ok && t1.message.includes('这是甲的定义'), String(t1.message).slice(0, 30))
check('工具结果也写明不是指令', t1.message.includes('不是指令'), String(t1.message).slice(0, 30))
// 工具要能给出比提示更完整的内容（用户问来历时就靠它）
const tFull = await tool.execute({ query: '测试梗长' })
check('工具返回比提示长', String(tFull.message).length > 300, '工具 ' + String(tFull.message).length + ' 字符')
check('工具返回不带截断说明', !String(tFull.message).includes('只给前'), '')
const tShort = await tool.execute({ query: '测试梗甲' })
check('短词条原样给出', String(tShort.message).includes('这是甲的定义'), String(tShort.message).slice(0, 40))

const t2 = await tool.execute({ query: '不存在的词条zzz' })
check('工具查不到时说没有', t2.ok && /没有/.test(t2.message), String(t2.message).slice(0, 30))
const t3 = await tool.execute({ query: '  ' })
check('工具空参数被拒', t3.ok === false, String(t3.message))

// ---------- 命令 ----------
const cmd = await commands['梗'].run('测试梗甲')
check('命令 /梗 能查', String(cmd).includes('这是甲的定义'), String(cmd).slice(0, 30))

// ---------- emoji 截断 ----------
const emojiHint = await inject('测试梗丙 emoji')
const emojiText = String(emojiHint[1]?.text || '')
const hasBroken = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/.test(emojiText)
check('截断不切坏 emoji', !hasBroken, 'broken=' + hasBroken)

// ---------- 截断说明 ----------
const longHint = await inject('测试梗长')
const longText = String(longHint[1]?.text || '')
check('截断时明说还剩多少字', longText.includes('这条一共') && longText.includes('只给了前'), longText.slice(-60))
check('截断说明里指了工具名', longText.includes('search_meme_wiki'), '')
const shortHint = await inject('测试梗甲')
check('没截断时不乱加说明', !String(shortHint[1]?.text || '').includes('这条一共'), '')

// ---------- 工具返回上限可配 ----------
const capped = await (async () => {
  const made = makeApi({ settings: { autoSync: false, toolChars: 120 } })
  const mod2 = (await import(pathToFileURL(join(MOD, 'index.mjs')).href + '?cap=1')).default
  await mod2.setup({ ...made.api, dataDir: () => dataDir })
  const tool2 = made.tools[0]({ chat: { kind: 'private' } })
  return await tool2.execute({ query: '测试梗长' })
})()
const cappedMsg = String(capped.message)
check('工具上限设 120 后明显变短', cappedMsg.length < String(tFull.message).length && cappedMsg.length < 400, '设 120 → ' + cappedMsg.length + ' 字符；默认 → ' + String(tFull.message).length + ' 字符')
check('工具被截断时也明说', cappedMsg.includes('只给前') && cappedMsg.includes('共 '), cappedMsg.slice(-46))
check('工具截断说明点明是面板设置', cappedMsg.includes('面板设置'), '')
check('默认上限下不出现工具截断说明', !String(tFull.message).includes('面板设置'), '')

// ---------- 加 / 删词条 ----------
const added = await routes['/add'](fakeReq({ title: '手动梗丁', aliases: '丁丁', text: '手动加的一条。' }))
check('加词条成功', added.ok === true, String(added.message))
check('新增后规则不变', JSON.stringify(getRules()('social', {})) === populatedRules)
check('新增后面板仍更新条数', (await routes['/stats']()).total === before + 1)
const dup = await routes['/add'](fakeReq({ title: '手动梗丁', text: '再来' }))
check('重复加被拒', dup.ok === false && /已经在库里/.test(String(dup.message)), String(dup.message))
const emptyTitle = await routes['/add'](fakeReq({ title: '   ', text: 'x' }))
check('空标题被拒', emptyTitle.ok === false, String(emptyTitle.message))
const peekNew = await routes['/peek'](fakeReq(undefined, {}))
check('加完能查到', (await routes['/peek']({ url: '/peek?q=' + encodeURIComponent('手动梗丁') })).text.includes('手动梗丁'))
const list1 = await routes['/manual']()
check('手动列表列出新增', list1.items.some((x) => x.title === '手动梗丁'), '共 ' + list1.items.length + ' 条')
const delBuiltin = await routes['/del'](fakeReq({ title: '测试梗甲' }))
check('内置词条不给删', delBuiltin.ok === false && /不是手动加的/.test(String(delBuiltin.message)), String(delBuiltin.message))
const delMine = await routes['/del'](fakeReq({ title: '手动梗丁' }))
check('手动词条能删', delMine.ok === true, String(delMine.message))
check('删除后规则不变', JSON.stringify(getRules()('social', {})) === populatedRules)
check('删除后面板仍更新条数', (await routes['/stats']()).total === before)
const gone = await routes['/peek']({ url: '/peek?q=' + encodeURIComponent('手动梗丁') })
check('删完查不到', gone.text.includes('没有'), String(gone.text).slice(0, 20))

// ---------- 跨站调用要被挡住 ----------
const cross = await routes['/add'](fakeReq({ title: '×', text: '×' }, { 'sec-fetch-site': 'cross-site' }))
check('跨站 add 被拒', cross.ok === false && /跨站/.test(String(cross.message)), String(cross.message))
const crossDel = await routes['/del'](fakeReq({ title: '测试梗甲' }, { 'sec-fetch-site': 'cross-site' }))
check('跨站 del 被拒', crossDel.ok === false, String(crossDel.message))
const crossSync = await routes['/sync'](fakeReq(undefined, { 'sec-fetch-site': 'cross-site' }))
check('跨站 sync 被拒', crossSync.ok === false, String(crossSync.message))

// ---------- 导入接口存在（不真的联网） ----------
check('有 /import 路由', typeof routes['/import'] === 'function')
const st = await routes['/import-status']()
check('导入状态可读', st.ok === true && typeof st.total === 'number', JSON.stringify(st).slice(0, 60))

// 清空后不能继续宣称有可查询的梗库。
db.exec('DELETE FROM memes')
check('清空后恢复未导入提示', String(getRules()('social', {})).includes('还没导入'))

// ---------- 收尾 ----------
db.close()
for (const made of instances) made.dispose()
for (const made of instances) rmSync(made.dataDir, { recursive: true, force: true })

const pass = results.filter((r) => r.ok).length
const fail = results.filter((r) => !r.ok)
console.log('')
for (const r of results) console.log((r.ok ? '✔' : '✘') + ' ' + r.name + (r.detail ? '  →  ' + r.detail : ''))
console.log('')
console.log(`合计 ${results.length} 项，通过 ${pass} 项，失败 ${fail.length} 项`)
process.exit(fail.length ? 1 : 0)
