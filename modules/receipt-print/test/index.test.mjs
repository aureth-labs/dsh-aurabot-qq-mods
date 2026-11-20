import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import mod from '../index.mjs'

function bodyReq(payload) {
  return {
    async *[Symbol.asyncIterator]() {
      yield Buffer.from(JSON.stringify(payload))
    },
  }
}

async function boot() {
  const dir = await mkdtemp(join(tmpdir(), 'receipt-index-'))
  const settings = {}
  const commands = new Map()
  const routes = new Map()
  const api = {
    id: 'receipt-print',
    settings: () => ({ ...settings }),
    saveSettings: (patch) => Object.assign(settings, patch),
    dataDir: (...parts) => (parts.length ? join(dir, ...parts) : dir),
    command: (def) => commands.set(def.name, def),
    route: (path, fn) => routes.set(path, fn),
    every: () => {},
    log: { info() {}, warn() {}, error() {}, debug() {} },
    ask: async () => '今天适合打印小票。\n第二行',
    think: async () => '想好了，今天适合打印小票。',
  }
  const exports = mod.setup(api)
  return { dir, settings, commands, routes, exports }
}

test('启动后自动种下「每日简报」模板', async () => {
  const { exports } = await boot()
  const templates = exports.templates()
  assert.equal(templates.length, 1)
  assert.equal(templates[0].name, '每日简报')
  assert.equal(templates[0].schedule.enabled, false)
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
  assert.equal(listed.templates.length, 1)

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
    patch: { printers: [{ name: 'POS-58', transport: 'windows', target: 'POS-58', paperWidthMm: 58 }] },
  }))
  assert.equal(saved.ok, true)
  assert.equal(saved.settings.printers.length, 1)
  assert.equal(saved.settings.printers[0].name, 'POS-58')
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

test('/打印机 列表显示 mm 和列数', async () => {
  const { commands, settings } = await boot()
  settings.printers = [{ name: 'POS-80', transport: 'preview', paperWidthMm: 80 }]
  const text = await commands.get('打印机').run('')
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

test('/自检：没配打印机时提示去加打印机', async () => {
  const { commands } = await boot()
  const text = await commands.get('自检').run('')
  assert.match(text, /还没有打印机/)
})

test('/自检：默认发内置 ESC/POS 自检页', async () => {
  const { commands, settings, exports } = await boot()
  settings.printers = [{ name: '预览机', transport: 'preview' }]
  const text = await commands.get('自检').run('')
  assert.match(text, /自检页已发到「预览机」/)
  assert.match(text, /32 列/)
  assert.equal(exports.templates().length, 1, '自检不影响模板')
})

test('/自检：自定义指令会替换内置自检页，非法时拒绝发送', async () => {
  const { commands, settings } = await boot()
  settings.printers = [{ name: '预览机', transport: 'preview' }]
  settings.selfTestHex = 'ZZ'
  assert.match(await commands.get('自检').run(''), /自检指令有问题/)

  settings.selfTestHex = '1B 40 1B 61 01'
  const ok = await commands.get('自检').run('')
  assert.match(ok, /自定义自检指令（5 字节）/)
})
