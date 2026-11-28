// 小游戏脚本工坊：把主人（或她自己）写的小游戏脚本存进指定目录，再用受限子进程跑起来。
// 入口只做定义和接线；设置、存储、运行器分别在 lib/policy.mjs、lib/store.mjs、lib/runner.mjs。
import { createStore } from './lib/store.mjs'
import { createRunner } from './lib/runner.mjs'
import { clip, describeConfig, fence, normalizeSettings } from './lib/policy.mjs'

const HELP = [
  '/脚本 列表',
  '/脚本 查看 <名字>',
  '/脚本 运行 <名字> [参数...]',
  '/脚本 删除 <名字> 确认',
  '/脚本 路径',
  '/脚本 帮助',
  '也可以直接发 /脚本 <名字> [参数...] 来跑。',
  '脚本名只能用小写字母、数字、_、-，1~40 个字。',
].join('\n')

const errorText = (error) => (error && error.message ? error.message : String(error))
const kb = (bytes) => Math.max(1, Math.round(bytes / 1024))

function timeText(ms) {
  const d = new Date(ms)
  const pad = (n) => String(n).padStart(2, '0')
  return d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate()) + ' ' + pad(d.getHours()) + ':' + pad(d.getMinutes())
}

function listText(rows, config) {
  if (!rows.length) return '还没有 ' + config.ext + ' 脚本。跟她说「写个……的小游戏」就行。'
  const lines = ['脚本（' + rows.length + '）：']
  for (const row of rows) lines.push('- ' + row.name + '（' + kb(row.bytes) + ' KB，' + timeText(row.updatedAt) + '）')
  return lines.join('\n')
}

/** @type {import('../aurabot').AurabotModule} */
export default {
  id: 'game-scripts',
  name: '小游戏脚本工坊',
  version: '0.1.0',
  api: 1,
  description: '她自己写小游戏脚本并在本机跑起来：主人指定脚本目录、Node 或 PowerShell 运行时、PowerShell 路径、超时和权限上限。默认用 Node 权限模型，不需要 PowerShell 7。',
  defaults: {
    scriptDir: '',
    runtime: 'node',
    powershellPath: 'pwsh',
    timeoutSeconds: 20,
    maxOutputKb: 16,
    maxScriptKb: 64,
    maxRunsPerHour: 30,
    nodeSandbox: true,
  },
  settings: [
    { key: 'scriptDir', label: '脚本目录', type: 'text', placeholder: 'D:\\AurabotScripts', hint: '留空用模块数据目录下的 scripts/；相对路径也相对模块数据目录' },
    { key: 'runtime', label: '运行时', type: 'select', options: [{ value: 'node', label: 'Node（默认，不需要 PowerShell）' }, { value: 'powershell', label: 'PowerShell' }], hint: 'Node 模式默认开权限模型；PowerShell 模式没有沙箱' },
    { key: 'powershellPath', label: 'PowerShell 路径', type: 'text', placeholder: 'C:\\Program Files\\PowerShell\\7\\pwsh.exe', hint: '只在运行时是 PowerShell 时用；默认 pwsh，找不到就填完整路径' },
    { key: 'timeoutSeconds', label: '单次超时（秒）', type: 'number', min: 1, max: 300, step: 1, hint: '默认 20 秒' },
    { key: 'maxOutputKb', label: '输出上限（KB）', type: 'number', min: 1, max: 64, step: 1, hint: '默认 16 KB；超了就停掉脚本' },
    { key: 'maxScriptKb', label: '脚本大小上限（KB）', type: 'number', min: 1, max: 512, step: 1, hint: '默认 64 KB' },
    { key: 'maxRunsPerHour', label: '每小时最多运行次数', type: 'number', min: 1, max: 200, step: 1, hint: '默认 30 次，重载模块后清零' },
    { key: 'nodeSandbox', label: 'Node 权限模型', type: 'switch', hint: '默认开：脚本只能读写脚本目录，不能启动子进程；关掉后脚本拥有和 Aurabot 一样的权限' },
  ],

  setup(api) {
    const getConfig = () => normalizeSettings(api.settings(), { dataDir: api.dataDir() })
    const store = createStore(getConfig)
    const runner = createRunner(getConfig, { log: api.log })

    const toolDefs = [
      api.defineTool({
        name: 'game_script_save',
        description: '把一个小游戏脚本写进主人的脚本目录。脚本要自包含：Node 模式是 ESM（.mjs），用 console.log 输出结果；PowerShell 模式是 .ps1，用 Write-Output。同名脚本已存在时要把 overwrite 设为 true。',
        properties: {
          name: { type: 'string', description: '脚本名：小写字母、数字、_、-，1~40 个字' },
          code: { type: 'string', description: '完整脚本内容' },
          overwrite: { type: 'boolean', description: 'true 表示覆盖同名脚本，默认 false' },
        },
        required: ['name', 'code'],
        execute: async ({ name, code, overwrite }) => {
          try {
            const result = await store.save(name, code, { overwrite: Boolean(overwrite) })
            return { ok: true, message: '脚本已写好：' + result.name + '（' + result.bytes + ' 字节）。用 game_script_run 跑它。' }
          } catch (error) {
            return { ok: false, message: errorText(error) }
          }
        },
      }),
      api.defineTool({
        name: 'game_script_run',
        description: '运行主人脚本目录里的一个小游戏脚本，返回退出码、stdout 和 stderr。默认 20 秒超时。脚本可以用 process.argv 取 args，也可以用 stdin 读 input。',
        properties: {
          name: { type: 'string', description: '脚本名' },
          args: { type: 'array', items: { type: 'string' }, description: '传给脚本的参数，最多 20 个' },
          input: { type: 'string', description: '写进脚本 stdin 的文字，最多 8000 个字；不需要就留空' },
        },
        required: ['name'],
        execute: async ({ name, args, input }) => {
          try {
            const result = await runner.run(name, { args: Array.isArray(args) ? args : [], input: input || '' })
            return { ok: result.ok, message: clip(result.message, 16000) }
          } catch (error) {
            return { ok: false, message: errorText(error) }
          }
        },
      }),
      api.defineTool({
        name: 'game_script_list',
        description: '列出主人脚本目录里现有的小游戏脚本（按修改时间倒序）。写新脚本前先看一眼，避免重名。',
        properties: {},
        execute: async () => {
          try {
            return { ok: true, message: listText(await store.list(), getConfig()) }
          } catch (error) {
            return { ok: false, message: errorText(error) }
          }
        },
      }),
      api.defineTool({
        name: 'game_script_read',
        description: '读一个现有小游戏脚本的源码。修改之前先读，别凭记忆覆盖。',
        properties: { name: { type: 'string', description: '脚本名' } },
        required: ['name'],
        execute: async ({ name }) => {
          try {
            const result = await store.read(name)
            return { ok: true, message: '脚本 ' + result.name + '：\n' + fence(result.code) }
          } catch (error) {
            return { ok: false, message: errorText(error) }
          }
        },
      }),
    ]

    async function handleCommand(arg, msg) {
      const tokens = String(arg || '').trim() ? String(arg || '').trim().split(/\s+/) : []
      const first = tokens.shift() || '列表'
      const action = first.toLowerCase()
      const privateChat = !msg || msg.kind === 'private'
      const config = getConfig()

      if (action === '列表' || action === 'list' || action === 'ls') {
        return clip(listText(await store.list(), config), 8000)
      }
      if (action === '帮助' || action === 'help' || action === '?') return HELP
      if (action === '路径' || action === 'path' || action === '设置' || action === 'config' || action === '状态') {
        if (!privateChat) return '路径和设置只在主人私聊里看。'
        return describeConfig(config)
      }
      if (action === '查看' || action === 'read' || action === '看' || action === '代码') {
        if (!privateChat) return '查看代码只在主人私聊里。'
        const name = tokens.shift()
        if (!name) return '要查看哪个脚本？/脚本 查看 <名字>'
        const result = await store.read(name)
        return clip('脚本 ' + result.name + '：\n' + fence(result.code), 8000)
      }
      if (action === '删除' || action === 'delete' || action === '删') {
        const name = tokens.shift()
        if (!name) return '要删除哪个脚本？/脚本 删除 <名字> 确认'
        if (!tokens.includes('确认') && !tokens.includes('confirm')) return '删除要加「确认」：/脚本 删除 ' + name + ' 确认'
        await store.remove(name)
        return '已删除脚本「' + name + '」。'
      }
      if (action === '运行' || action === 'run' || action === '跑' || action === '玩') {
        const name = tokens.shift()
        if (!name) return '要运行哪个脚本？/脚本 运行 <名字> [参数...]'
        return clip((await runner.run(name, { args: tokens })).message, 8000)
      }

      // 不认识的第一个词当成脚本名：/脚本 snake 3
      return clip((await runner.run(first, { args: tokens })).message, 8000)
    }

    api.command({
      name: '脚本',
      aliases: ['小游戏脚本', 'gamescript'],
      desc: '写、看、运行或删除小游戏脚本',
      sensitive: true,
      run: async (arg, msg) => {
        try {
          return await handleCommand(arg, msg)
        } catch (error) {
          return '脚本工坊：' + errorText(error)
        }
      },
    })

    // 写脚本和跑脚本只在主人私聊里给工具；群里用 /脚本 命令。
    api.tool((where) => {
      if (!where || where.level !== 'full') return []
      if (!where.chat || where.chat.kind !== 'private') return []
      return toolDefs
    })

    api.rule((kind) => {
      if (kind !== 'private') return ''
      return '你会写小游戏脚本：主人让你做小游戏时，用 game_script_save 写、game_script_run 跑，写之前先用 game_script_list 看看。脚本是自包含的，用 console.log 输出结果；能读 stdin 的 input。脚本目录、运行时和超时都由主人在面板里设好。'
    })

    api.log.info('[game-scripts] 已加载：/脚本 可用，默认运行时 Node')

    return {
      dispose: () => runner.dispose(),
    }
  },
}
