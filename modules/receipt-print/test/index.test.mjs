import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, readFile, readdir } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import mod from '../index.mjs'
import { TERMS_VERSION } from '../lib/terms.mjs'

function bodyReq(payload) {
  return {
    async *[Symbol.asyncIterator]() {
      yield Buffer.from(JSON.stringify(payload))
    },
  }
}

async function boot({ diary = null, config = null, sendText = null, terms = true } = {}) {
  const dir = await mkdtemp(join(tmpdir(), 'receipt-index-'))
  const settings = terms ? { termsVersion: TERMS_VERSION } : {}
  const commands = new Map()
  const routes = new Map()
  const ticks = new Map()
  const sent = []
  const api = {
    id: 'receipt-print',
    settings: () => ({ ...settings }),
    saveSettings: (patch) => Object.assign(settings, patch),
    dataDir: (...parts) => (parts.length ? join(dir, ...parts) : dir),
    command: (def) => commands.set(def.name, def),
    route: (path, fn) => routes.set(path, fn),
    every: (ms, fn, name) => ticks.set(name || String(ms), fn),
    use: (id) => (id === 'diary' ? diary : null),
    config: () => config || {},
    sendText: async (target, text) => {
      sent.push({ target, text })
      if (sendText) await sendText(target, text)
    },
    log: { info() {}, warn() {}, error() {}, debug() {} },
    ask: async () => '今天适合打印小票。\n第二行',
    think: async () => '想好了，今天适合打印小票。',
  }
  const exports = mod.setup(api)
  return { dir, settings, commands, routes, ticks, exports, sent }
}

test('启动后自动种下「每日简报」和「今日总结」', async () => {
  const { exports } = await boot()
  const templates = exports.templates()
  assert.equal(templates.length, 2)
  const brief = templates.find((t) => t.name === '每日简报')
  assert.equal(brief.schedule.enabled, false)

  const summary = templates.find((t) => t.name === '今日总结')
  assert.equal(summary.schedule.enabled, true)
  assert.equal(summary.schedule.time, '18:00')
  assert.deepEqual(summary.schedule.days, [])
})

test('/小票 列表', async () => {
  const { commands } = await boot()
  const text = await commands.get('小票').run('')
  assert.match(text, /每日简报/)
  assert.match(text, /用法/)
})

test('/小票 预览 走模型但不出纸', async () => {
  const { commands, settings } = await boot()
  const text = await commands.get('小票').run('预览 每日简报')
  assert.match(text, /预览/)
  assert.match(text, /今天适合打印小票/)
  assert.equal(settings.printers, undefined)
})

test('/小票 加 和 /小票 删', async () => {
  const { commands, exports } = await boot()
  const added = await commands.get('小票').run('加 待办 | 列出今天要做的三件事')
  assert.match(added, /已建模板/)
  assert.ok(exports.templates().some((t) => t.name === '待办'))
  const removed = await commands.get('小票').run('删 待办')
  assert.match(removed, /已删除/)
  assert.ok(!exports.templates().some((t) => t.name === '待办'))
})

test('/打印 没配打印机时回预览', async () => {
  const { commands } = await boot()
  const text = await commands.get('打印').run('一段测试文字')
  assert.match(text, /还没有配置打印机/)
  assert.match(text, /一段测试文字/)
})

test('面板接口：模板、保存、运行预览、历史、快速预览', async () => {
  const { routes } = await boot()

  const listed = routes.get('/templates')()
  assert.equal(listed.ok, true)
  assert.equal(listed.templates.length, 2)
  assert.ok(listed.templates.some((t) => t.name === '今日总结'))
  assert.match(listed.version, /^\d+\.\d+\.\d+$/)
  assert.equal(listed.stage, '测试')

  const saved = await routes.get('/save')(bodyReq({ template: { name: '周报', prompt: '写周报' } }))
  assert.equal(saved.ok, true)
  assert.equal(saved.template.name, '周报')

  const run = await routes.get('/run')(bodyReq({ id: saved.template.id, preview: true }))
  assert.equal(run.ok, true)
  assert.match(run.preview, /今天适合打印小票/)

  const history = routes.get('/history')()
  assert.equal(history.ok, true)
  assert.equal(history.history.length, 0)

  const preview = await routes.get('/preview')(bodyReq({ text: '预览内容' }))
  assert.equal(preview.ok, true)
  assert.match(preview.preview, /预览内容/)

  const deleted = await routes.get('/delete')(bodyReq({ id: saved.template.id }))
  assert.equal(deleted.ok, true)
})

test('面板接口：保存打印机设置', async () => {
  const { routes } = await boot()
  const saved = await routes.get('/settings')(bodyReq({
    patch: { printer: { name: 'POS-58', transport: 'windows', target: 'POS-58', paperWidthMm: 58 } },
  }))
  assert.equal(saved.ok, true)
  assert.equal(saved.settings.printer.name, 'POS-58')
  assert.equal(saved.settings.printers, undefined)
})

test('说说自动打印默认开启', async () => {
  const { routes } = await boot()
  const res = await routes.get('/settings')(bodyReq({}))
  assert.equal(res.settings.momentAuto, true)
  assert.equal(res.settings.momentImages, true)
})

test('每日彩蛋默认开启', async () => {
  const { routes } = await boot()
  const res = await routes.get('/settings')(bodyReq({}))
  assert.equal(res.settings.fun, true)
})

test('纸宽 mm 会换算成每行列数', async () => {
  const { routes, settings } = await boot()
  settings.paperWidthMm = 80
  const wide = await routes.get('/preview')(bodyReq({ text: '测试' }))
  assert.equal(wide.paperWidthMm, 80)
  assert.equal(wide.effectiveWidthMm, 72)
  assert.equal(wide.columns, 48)

  settings.paperWidthMm = 58
  settings.effectiveWidthMm = 40
  const narrow = await routes.get('/preview')(bodyReq({ text: '测试' }))
  assert.equal(narrow.effectiveWidthMm, 40)
  assert.equal(narrow.columns, 26)
})

test('/打印机 显示单台打印机和列数', async () => {
  const { commands, settings } = await boot()
  settings.printer = { name: 'POS-80', transport: 'preview', paperWidthMm: 80 }
  const text = await commands.get('打印机').run('')
  assert.match(text, /POS-80/)
  assert.match(text, /80mm \/ 48 列/)
  assert.match(text, /每行 32 列/, '全局默认仍是 58mm')
})

test('旧配置 width=48 会迁移成 80mm', async () => {
  const { routes, settings } = await boot()
  settings.width = 48
  const preview = await routes.get('/preview')(bodyReq({ text: 'x' }))
  assert.equal(preview.paperWidthMm, 80)
  assert.equal(preview.columns, 48)
})

test('/自检：没配打印机时提示去配置', async () => {
  const { commands } = await boot()
  const text = await commands.get('自检').run('')
  assert.match(text, /还没有配置打印机/)
})

test('/自检：默认发内置 ESC/POS 自检页', async () => {
  const { commands, settings, exports } = await boot()
  settings.printer = { name: '预览机', transport: 'preview' }
  const text = await commands.get('自检').run('')
  assert.match(text, /自检页已发到「预览机」/)
  assert.match(text, /32 列/)
  assert.equal(exports.templates().length, 2, '自检不影响模板')
})

test('/自检：旧配置的 printers 数组取第一台', async () => {
  const { commands, settings } = await boot()
  settings.printers = [{ name: '旧机', transport: 'preview' }]
  assert.match(await commands.get('自检').run(''), /自检页已发到「旧机」/)
})

test('/自检：自定义指令会替换内置自检页，非法时拒绝发送', async () => {
  const { commands, settings } = await boot()
  settings.printer = { name: '预览机', transport: 'preview' }
  settings.selfTestHex = 'ZZ'
  assert.match(await commands.get('自检').run(''), /自检指令有问题/)

  settings.selfTestHex = '1B 40 1B 61 01'
  const ok = await commands.get('自检').run('')
  assert.match(ok, /自定义自检指令（5 字节）/)
})

test('说说：首次启动只记水位，不补打旧说说', async () => {
  const diary = { entries: [{ at: Date.now() - 60000, text: '很久以前的说说' }], async history() { return this.entries.slice() } }
  const { settings, exports, routes } = await boot({ diary })
  settings.printer = { name: '预览机', transport: 'preview' }
  await exports.checkMoments()
  assert.equal(routes.get('/history')().history.length, 0)
})

test('说说：新的公开说说自动打印并推进水位', async () => {
  const base = Date.now() - 60000
  const diary = { entries: [{ at: base, text: '旧说说' }], async history() { return this.entries.slice() } }
  const { settings, exports, routes } = await boot({ diary })
  settings.printer = { name: '预览机', transport: 'preview' }
  await exports.checkMoments()

  diary.entries.push({ at: base + 10000, text: '新说说：今天风很大' })
  await exports.checkMoments()
  const history = routes.get('/history')().history
  assert.equal(history.length, 1)
  assert.equal(history[0].template, '说说')
  assert.ok(history[0].ok)

  await exports.checkMoments()
  assert.equal(routes.get('/history')().history.length, 1, '同一个说说不会重复打印')
})

test('说说：默认跳过仅自己可见的', async () => {
  const base = Date.now() - 60000
  const diary = { entries: [{ at: base, text: '旧说说' }], async history() { return this.entries.slice() } }
  const { settings, exports, routes } = await boot({ diary })
  settings.printer = { name: '预览机', transport: 'preview' }
  await exports.checkMoments()

  diary.entries.push({ at: base + 10000, text: '只给自己看', visibility: 'self' })
  await exports.checkMoments()
  assert.equal(routes.get('/history')().history.length, 0)

  diary.entries.push({ at: base + 20000, text: '公开的', visibility: 'public' })
  await exports.checkMoments()
  assert.equal(routes.get('/history')().history.length, 1)
  assert.equal(routes.get('/history')().history[0].template, '说说')
})

test('说说：配图会按纸宽做成位图后再打印', async () => {
  const { PNG } = (await import('pngjs')).default
  const png = new PNG({ width: 2, height: 2 })
  png.data.fill(255)
  const dataUrl = 'data:image/png;base64,' + PNG.sync.write(png).toString('base64')

  const base = Date.now() - 60000
  const diary = { entries: [{ at: base, text: '旧说说' }], async history() { return this.entries.slice() } }
  const { settings, exports, routes } = await boot({ diary })
  settings.printer = { name: '预览机', transport: 'preview' }
  await exports.checkMoments()

  diary.entries.push({ at: base + 10000, text: '带图说说', images: [dataUrl] })
  await exports.checkMoments()
  const history = routes.get('/history')().history
  assert.equal(history.length, 1)
  assert.equal(history[0].images, 1)
})

test('/小票 解码 能读懂发出去的指令', async () => {
  const { commands } = await boot()
  const text = await commands.get('小票').run('解码 1B 40 1B 61 01 1D 56 01')
  assert.match(text, /初始化打印机/)
  assert.match(text, /居中/)
  assert.match(text, /半切/)
})

test('/小票 指令 能查指令表', async () => {
  const { commands } = await boot()
  const text = await commands.get('小票').run('指令 切纸')
  assert.match(text, /GS V/)
})

test('/小票 状态 在预览模式下说明读不到', async () => {
  const { settings, commands } = await boot()
  settings.printer = { name: 'demo', transport: 'preview', paperWidthMm: 58 }
  const text = await commands.get('小票').run('状态')
  assert.match(text, /预览模式/)
})

test('打印失败会私聊主人', async () => {
  const { settings, commands, sent } = await boot({ config: { ownerQQ: '10001' } })
  settings.printer = { name: 'lan', transport: 'tcp', target: '127.0.0.1:1', paperWidthMm: 58 }
  const text = await commands.get('小票').run('每日简报')
  assert.match(text, /打印失败/)
  await new Promise((resolve) => setTimeout(resolve, 100))
  assert.equal(sent.length, 1)
  assert.equal(sent[0].target, 'private:10001')
  assert.match(sent[0].text, /打印失败/)
})

test('/小票 记录 显示触发类型、原因和备份正文', async () => {
  const { settings, commands, dir } = await boot()
  settings.printer = { name: '预览机', transport: 'preview', paperWidthMm: 58 }
  await commands.get('小票').run('每日简报')

  const list = await commands.get('小票').run('记录')
  assert.match(list, /命令（命令 \/小票 每日简报）/)
  assert.match(list, /成功/)

  const detail = await commands.get('小票').run('记录 1')
  assert.match(detail, /触发：命令（命令 \/小票 每日简报）/)
  assert.match(detail, /备份：backups\//)
  assert.match(detail, /今天适合打印小票/)

  const raw = JSON.parse(await readFile(join(dir, 'state.json'), 'utf8'))
  assert.equal(raw.history[0].trigger.type, 'command')
  assert.ok(raw.history[0].text.includes('今天适合打印小票'))
  const backup = await readFile(join(dir, raw.history[0].backup), 'utf8')
  assert.match(backup, /触发类型：command/)
})

test('说说自动打印记录触发来源和说说 ID', async () => {
  const diary = {
    entries: [{ id: 'old', at: Date.now() - 60000, text: '很久以前', images: [] }],
    async history() { return this.entries.slice() },
  }
  const { settings, exports, routes } = await boot({ diary })
  settings.printer = { name: '预览机', transport: 'preview', paperWidthMm: 58 }
  await exports.checkMoments()
  diary.entries.push({ id: 'm-42', at: Date.now(), text: '刚发的说说', images: [] })
  await exports.checkMoments()

  const history = routes.get('/history')().history
  assert.equal(history.length, 1)
  assert.equal(history[0].trigger.type, 'moment')
  assert.match(history[0].trigger.reason, /说说 #m-42 发布/)
  assert.equal(history[0].trigger.momentId, 'm-42')
})

test('设置里的备份目录生效，一次打印一个文件', async () => {
  const { commands, settings, dir } = await boot()
  settings.printer = { name: '预览机', transport: 'preview', paperWidthMm: 58 }
  const custom = await mkdtemp(join(tmpdir(), 'receipt-custom-'))
  settings.backupDir = custom

  await commands.get('小票').run('每日简报')
  const files = (await readdir(custom)).filter((f) => f.startsWith('receipt-'))
  assert.equal(files.length, 1)

  const raw = JSON.parse(await readFile(join(dir, 'state.json'), 'utf8'))
  assert.equal(raw.history[0].backup, join(custom, files[0]))
})

test('/小票 校准 出校准页并留备份', async () => {
  const { commands, settings, dir } = await boot()
  settings.printer = { name: '预览机', transport: 'preview', paperWidthMm: 58 }

  const text = await commands.get('小票').run('校准')
  assert.match(text, /校准页/)

  const raw = JSON.parse(await readFile(join(dir, 'state.json'), 'utf8'))
  assert.equal(raw.history[0].template, '校准页')
  assert.equal(raw.history[0].trigger.type, 'command')
  assert.match(raw.history[0].text, /48mm #/)
})

test('面板 /calibrate 也能打印校准页', async () => {
  const { routes, settings } = await boot()
  settings.printer = { name: '预览机', transport: 'preview', paperWidthMm: 58 }

  const result = await routes.get('/calibrate')({})
  assert.equal(result.ok, true)
  assert.match(result.message, /48mm/)
})

test('未同意协议时拒绝打印，同意后恢复', async () => {
  const { commands, settings, dir } = await boot({ terms: false })
  settings.printer = { name: '预览机', transport: 'preview', paperWidthMm: 58 }

  const blocked = await commands.get('小票').run('每日简报')
  assert.match(blocked, /同意/)
  assert.match(blocked, /\/小票 协议/)
  assert.equal(settings.termsVersion, undefined)

  const agreement = await commands.get('小票').run('协议')
  assert.match(agreement, /热敏打印使用协议/)
  assert.match(agreement, /备份/)

  const accepted = await commands.get('小票').run('同意')
  assert.match(accepted, /已确认/)
  assert.equal(settings.termsVersion, TERMS_VERSION)
  assert.ok(settings.termsAcceptedAt)

  const printed = await commands.get('小票').run('每日简报')
  assert.match(printed, /已发送/)

  const raw = JSON.parse(await readFile(join(dir, 'state.json'), 'utf8'))
  assert.equal(raw.history.length, 1)
})

test('未同意协议时 /打印 和 /自检 也被拦住', async () => {
  const { commands, settings } = await boot({ terms: false })
  settings.printer = { name: '预览机', transport: 'preview', paperWidthMm: 58 }

  assert.match(await commands.get('打印').run('你好'), /同意/)
  assert.match(await commands.get('自检').run(''), /同意/)
  assert.match(await commands.get('打印机').run('状态'), /同意/)
})

test('面板 /accept 能确认协议并回传条款状态', async () => {
  const { routes, settings } = await boot({ terms: false })
  const result = await routes.get('/accept')({})
  assert.equal(result.ok, true)
  assert.equal(result.terms.accepted, true)
  assert.equal(settings.termsVersion, TERMS_VERSION)
})

test('旧版本的协议确认会失效', async () => {
  const { commands, settings } = await boot({ terms: false })
  settings.termsVersion = '0.9'
  settings.printer = { name: '预览机', transport: 'preview', paperWidthMm: 58 }

  assert.match(await commands.get('小票').run('每日简报'), /同意/)
})
