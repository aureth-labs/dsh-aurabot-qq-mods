import { rmSync } from 'node:fs'
import { createStore, publicState } from './lib/store.mjs'
import { createRunner } from './lib/runner.mjs'
import { createJdQr } from './lib/jd-qr.mjs'
import { parseCron } from './lib/cron.mjs'

/** @type {import('../aurabot').AurabotModule} */
export default {
  id: 'wool-runner',
  name: '薅羊毛任务中心',
  version: '1.1.0',
  api: 1,
  description: '参考青龙的订阅、环境变量、Cron 任务与日志管理，内置 jdpro、smzdm_script、QLScriptPublic 源，支持京东扫码获取 JD_COOKIE',
  panel: 'panel.js',
  defaults: { enabled: false, nodePath: '', pythonPath: '', bashPath: '', timeoutMinutes: 30, maxConcurrent: 2, memoryMb: 256 },
  settings: [
    { key: 'enabled', label: '允许执行脚本（总开关）', type: 'switch', hint: '默认关闭；关闭时手动和定时执行都会被拒绝，订阅管理与扫码配置仍可使用' },
    { key: 'nodePath', label: 'Node.js 路径（可选）', type: 'text', hint: '留空使用 DSH 当前运行时；也可填本机 node.exe 的绝对路径' },
    { key: 'pythonPath', label: 'Python 路径（可选）', type: 'text', hint: '运行 .py 脚本时使用，留空从 PATH 查找 python' },
    { key: 'bashPath', label: 'Bash 路径（可选）', type: 'text', hint: '运行 .sh 脚本时使用，留空从 PATH 查找 bash' },
    { key: 'timeoutMinutes', label: '单任务超时（分钟）', type: 'number', min: 1, max: 240, step: 1 },
    { key: 'maxConcurrent', label: '最大并发任务数', type: 'number', min: 1, max: 4, step: 1 },
    { key: 'memoryMb', label: 'Node.js 堆内存上限（MiB）', type: 'number', min: 64, max: 2048, step: 64 },
  ],
  setup(api) {
    const store = createStore(api.dataDir())
    const runner = createRunner({ store, log: api.log, settings: api.settings })
    const qr = createJdQr({ store })
    const body = async (req) => api.core.http.body(req)
    const route = (path, handler) => api.route(path, async (req, res) => {
      try { return await handler(req, res) }
      catch (error) { return { ok: false, message: String(error?.message || error).slice(0, 1200) } }
    }, { access: 'panel' })
    const state = () => ({ ok: true, ...publicState(store, runner.runtime) })

    route('/state', state)
    route('/subscription/add', async (req) => {
      const item = store.addSubscription(await body(req))
      // 新增订阅即刻拉一次源码并把识别到 Cron 的脚本登记为定时任务（新任务仍默认停用、待审批）
      let synced = null
      if (item.enabled !== false) {
        try { synced = await runner.sync(item.id) }
        catch (error) {
          return { ok: true, item, syncError: String(error?.message || error).slice(0, 600), message: `订阅已保存，但首次同步失败：${String(error?.message || error).slice(0, 200)}。可点「立即同步」重试。` }
        }
      }
      return { ok: true, item, syncError: null, message: `订阅已保存并同步${synced?.added ? `，新增 ${synced.added} 个定时任务` : ''}` }
    })
    route('/subscription/update', async (req) => {
      const input = await body(req)
      if (!input.id) throw new Error('缺少订阅 id')
      const before = store.state().subscriptions.find((s) => s.id === input.id)
      const sourceChanged = before && (String(input.url ?? before.url) !== before.url || String(input.branch ?? before.branch) !== before.branch)
      const item = store.updateSubscription(input.id, input)
      if (!item.enabled) store.revokeTasks(item.id, '订阅已停用，任务已关闭且旧审批失效')
      // 刚打开「自动发现 Cron」或换了源，就顺手同步一次，让定时任务立即出现
      let synced = null
      if (item.enabled !== false && (sourceChanged || (before && before.autoAddCron !== true && item.autoAddCron === true))) {
        try { synced = await runner.sync(item.id) } catch (error) { return { ok: true, item, syncError: String(error?.message || error).slice(0, 600) } }
      }
      return { ok: true, item, syncError: null, synced }
    })
    route('/subscription/sync', async (req) => runner.sync(String((await body(req)).id || '')))
    route('/subscription/delete', async (req) => {
      const input = await body(req)
      const id = String(input.id || '')
      const related = store.state().tasks.filter((t) => t.subscriptionId === id)
      await Promise.all(related.map((t) => runner.stop(t.id, '删除订阅')))
      const item = store.removeSubscription(id)
      if (input.purge) rmSync(runner.repoDir(item.id), { recursive: true, force: true })
      return { ok: true, message: input.purge ? '订阅、任务和本地源码已删除' : '订阅和关联任务已删除，本地源码保留' }
    })
    route('/scripts', async (req) => {
      const id = api.core.http.query(req).id
      return { ok: true, items: runner.discover(String(id || '')) }
    })
    route('/task/add', async (req) => {
      const input = await body(req)
      const sub = store.state().subscriptions.find((s) => s.id === input.subscriptionId)
      if (!sub) throw new Error('订阅不存在，请先同步该订阅')
      const discovered = runner.discover(sub.id)
      if (!discovered.length) throw new Error('这个订阅还没有本地源码，请先点「立即同步」')
      const script = discovered.find((x) => x.id === input.scriptId || x.file === input.file)
      if (!script) throw new Error('脚本不存在，请重新同步后再试')
      const cron = String(input.cron || script.cron || '').trim()
      if (!cron) throw new Error('这个脚本没有识别到 Cron，请手动填写 5 或 6 字段表达式（如 0 8 * * *）')
      parseCron(cron)
      const existing = store.state().tasks.find((t) => t.id === script.id)
      if (existing) {
        // 同步已经自动建过这个任务：不报错，改为更新表达式并提示，避免「添加」永远失败
        const changed = existing.cron !== cron
        const item = changed
          ? store.upsertTask({ ...existing, cron, enabled: false, revokedReason: 'Cron 已修改，请重新确认后启用' })
          : existing
        return { ok: true, existed: true, item, message: changed ? `任务已存在，Cron 已更新为 ${cron} 并停用，请重新确认` : '这个脚本的任务已经存在，无需重复添加' }
      }
      return { ok: true, existed: false, item: store.upsertTask({ id: script.id, subscriptionId: sub.id, file: script.file, name: String(input.name || script.name), cron, enabled: false, envNames: [], approval: null }) }
    })
    route('/task/update', async (req) => {
      const input = await body(req)
      const old = store.state().tasks.find((t) => t.id === input.id)
      if (!old) throw new Error('任务不存在')
      if (input.cron !== undefined) parseCron(input.cron)
      if (input.enabled === true && input.confirm !== true) return { ok: false, needsConfirmation: true, message: '启用定时前必须确认来源与脚本内容' }
      const approval = input.enabled === true ? runner.authorize(old.id).approval : old.approval
      const cronChanged = input.cron !== undefined && input.cron !== old.cron
      return { ok: true, item: store.upsertTask({ ...old, name: input.name === undefined ? old.name : String(input.name).slice(0, 120), cron: input.cron ?? old.cron, enabled: cronChanged ? false : input.enabled === undefined ? old.enabled : input.enabled === true, approval }) }
    })
    route('/task/env', async (req) => {
      const input = await body(req)
      const old = store.state().tasks.find((t) => t.id === input.id)
      if (!old) throw new Error('任务不存在')
      const known = new Set(store.envList().map((x) => x.name))
      const envNames = [...new Set((Array.isArray(input.names) ? input.names : []).map((x) => String(x).trim()).filter(Boolean))]
      for (const name of envNames) if (!known.has(name)) throw new Error(`环境变量 ${name} 不存在`)
      store.upsertTask({ ...old, envNames })
      return { ok: true, message: envNames.length ? `已授权 ${envNames.join('、')}` : '已设为不注入任何自定义凭据' }
    })
    route('/task/enable-all', async (req) => {
      const input = await body(req)
      // subscriptionId 为空表示全部订阅；confirm 必须为 true，一键开启等同于逐条确认当前源码
      const scope = String(input.subscriptionId || '')
      const targets = store.state().tasks.filter((t) => (!scope || t.subscriptionId === scope))
      if (!targets.length) return { ok: true, enabled: 0, skipped: 0, message: scope ? '这个订阅下还没有任务' : '还没有任务' }
      if (input.confirm !== true) return { ok: false, needsConfirmation: true, count: targets.length, message: `将确认并启用 ${targets.length} 个任务，需要确认` }
      const subOf = (id) => store.state().subscriptions.find((s) => s.id === id)
      let enabled = 0
      const failed = []
      for (const item of targets) {
        const sub = subOf(item.subscriptionId)
        if (!sub || !sub.enabled) { failed.push({ name: item.name, reason: '订阅已停用' }); continue }
        try {
          // 逐个审批：审批仍绑定各自的 url/branch/commit/file/sha256，只是把确认动作批量化
          runner.authorize(item.id)
          store.upsertTask({ ...store.state().tasks.find((t) => t.id === item.id), enabled: true })
          enabled++
        } catch (error) { failed.push({ name: item.name, reason: String(error?.message || error).slice(0, 120) }) }
      }
      return {
        ok: true, enabled, skipped: failed.length, failed: failed.slice(0, 20),
        message: `已确认并启用 ${enabled} 个任务${failed.length ? `，${failed.length} 个跳过` : ''}`,
      }
    })
    route('/task/disable-all', async (req) => {
      const scope = String((await body(req)).subscriptionId || '')
      const targets = store.state().tasks.filter((t) => !scope || t.subscriptionId === scope)
      let count = 0
      for (const t of targets) if (t.enabled) { store.upsertTask({ ...t, enabled: false }); count++ }
      return { ok: true, disabled: count, message: `已停用 ${count} 个任务（审批保留）` }
    })
    route('/task/run', async (req) => {
      const input = await body(req)
      return runner.run(String(input.id || ''), 'manual', { confirm: input.confirm === true })
    })
    route('/task/stop', async (req) => runner.stop(String((await body(req)).id || '')))
    route('/task/delete', async (req) => {
      const id = String((await body(req)).id || '')
      await runner.stop(id, '删除任务')
      store.removeTask(id)
      return { ok: true, message: '任务已删除，订阅源码保留' }
    })
    route('/log', async (req) => ({ ok: true, ...await runner.readLog(api.core.http.query(req).id) }))
    route('/env/save', async (req) => ({ ok: true, item: store.upsertEnv(await body(req)) }))
    route('/env/delete', async (req) => { store.removeEnv(String((await body(req)).id || '')); return { ok: true, message: '环境变量已删除' } })
    route('/qr/jd/start', async () => qr.start())
    route('/qr/jd/poll', async (req) => qr.poll(String((await body(req)).session || '')))
    route('/qr/jd/cancel', async (req) => qr.cancel(String((await body(req)).session || '')))

    api.every(1000, () => runner.tick(), '薅羊毛 Cron 调度')
    api.onDispose(() => runner.dispose())
    api.command({
      name: '羊毛', desc: '查看薅羊毛任务状态：/羊毛 列表',
      async run() {
        const tasks = store.state().tasks
        return tasks.length ? tasks.map((t, i) => `${i + 1}. ${t.name}｜${t.enabled ? '定时开' : '定时关'}｜${t.lastStatus || '未运行'}`).join('\n') : '还没有任务，请先到 Aurabot 面板的「薅羊毛任务中心」添加。'
      },
    })
    api.tool(({ level, chat }) => level === 'full' && chat.kind === 'private' ? api.defineTool({
      name: 'wool_tasks',
      description: '只读查看主人在 Aurabot 薅羊毛任务中心里配置的任务状态。不能运行脚本、新增任务、修改定时或读取环境变量；执行和启用只能在面板中由主人确认。',
      properties: {},
      required: [],
      execute: async () => ({ ok: true, tasks: store.state().tasks.map((t) => ({ name: t.name, enabled: t.enabled, approved: Boolean(t.approval), lastStatus: t.lastStatus || 'never' })) }),
    }) : [])
    return { state }
  },
}
