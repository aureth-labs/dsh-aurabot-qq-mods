import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { parseCron, cronMatches, extractCron } from '../modules/wool-runner/lib/cron.mjs'
import { createStore, publicState } from '../modules/wool-runner/lib/store.mjs'
import { createRunner } from '../modules/wool-runner/lib/runner.mjs'

const temp = (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'wool-runner-'))
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  return dir
}

const fixture = (t, root, { script = '// cron */1 * * * * *\nconsole.log("selftest-ok")\nconsole.log("secret=" + (process.env.AURABOT_SELFTEST || "none"))\nconsole.log("host-env=" + (process.env.AURABOT_HOST_SECRET || "absent"))\n', envs = [] } = {}) => {
  const store = createStore(root)
  store.addSubscription({ id: 'local-test', name: '本地测试', url: 'https://example.com/repo.git' })
  const repo = join(store.root, 'repos', 'local-test')
  mkdirSync(repo, { recursive: true })
  writeFileSync(join(repo, 'selftest.js'), script)
  for (const e of envs) store.upsertEnv(e)
  const base = { enabled: true, nodePath: process.execPath, timeoutMinutes: 1, maxConcurrent: 2, memoryMb: 128 }
  const settings = { ...base }
  const runner = createRunner({ store, settings: () => ({ ...settings }) })
  t.after(() => runner.dispose())
  const [found] = runner.discover('local-test')
  store.upsertTask({ id: found.id, subscriptionId: 'local-test', file: found.file, name: '自测任务', cron: found.cron, enabled: false, envNames: [] })
  return { store, runner, settings, task: () => store.state().tasks.find((x) => x.id === found.id), taskId: found.id }
}

const waitFinish = async (store, id, limit = 200) => {
  for (let i = 0; i < limit; i++) {
    const t = store.state().tasks.find((x) => x.id === id)
    if (t.lastStatus && t.lastStatus !== 'running') return t
    await new Promise((r) => setTimeout(r, 50))
  }
  throw new Error('等待任务结束超时')
}

test('支持 5/6 字段 Cron、月份星期名称和块注释提取', () => {
  assert.equal(cronMatches(parseCron('0 8 * * *'), new Date(2026, 0, 1, 8, 0, 0)), true)
  assert.equal(cronMatches(parseCron('*/5 * * * * *'), new Date(2026, 0, 1, 0, 0, 5)), true)
  assert.equal(cronMatches(parseCron('0 0 9 * jan mon'), new Date(2026, 0, 5, 9, 0, 0)), true)
  assert.equal(extractCron('/* cron 31 11 * * *\n * next line */'), '31 11 * * *')
  assert.equal(extractCron('// cron: 0 8 * * *'), '0 8 * * *')
  assert.equal(extractCron('const cron = "15 2 * * *"'), '15 2 * * *')
  assert.throws(() => parseCron('invalid'), /5 或 6/)
})

test('环境变量列表与公开状态不泄露变量值', (t) => {
  const store = createStore(temp(t))
  store.upsertEnv({ name: 'JD_COOKIE', value: 'pt_key=fake-secret;pt_pin=fake-user;' })
  assert.equal(store.envValues().JD_COOKIE, 'pt_key=fake-secret;pt_pin=fake-user;')
  assert.equal(store.envValues([]).JD_COOKIE, undefined, '未授权任务拿不到任何变量')
  assert.equal(store.envValues(['JD_COOKIE']).JD_COOKIE, 'pt_key=fake-secret;pt_pin=fake-user;')
  assert.equal('value' in store.envList()[0], false)
  assert.equal(JSON.stringify(publicState(store)).includes('fake-secret'), false)
  assert.throws(() => store.upsertEnv({ name: 'BAD-NAME', value: 'x' }), /变量名/)
  assert.throws(() => store.addSubscription({ id: 'bad', url: 'https://user:token@example.com/repo.git' }), /令牌|账号|密码/)
})

test('总开关关闭时拒绝执行，打开后需显式确认才运行', async (t) => {
  const fx = fixture(t, temp(t))
  fx.settings.enabled = false
  await assert.rejects(fx.runner.run(fx.taskId, 'manual', { confirm: true }), /总开关/)
  fx.settings.enabled = true
  const ask = await fx.runner.run(fx.taskId, 'manual')
  assert.equal(ask.needsConfirmation, true, '未确认时只返回确认请求，不执行')
  assert.ok(ask.source.sha256 && ask.source.url)
})

test('任务级凭据授权：未授权变量不注入子进程', async (t) => {
  const fx = fixture(t, temp(t), { envs: [{ name: 'AURABOT_SELFTEST', value: 'granted-value' }, { name: 'AURABOT_HOST_SECRET', value: 'should-not-leak' }] })
  process.env.AURABOT_HOST_SECRET = 'inherited-host-value'
  t.after(() => delete process.env.AURABOT_HOST_SECRET)
  fx.settings.enabled = true
  // 只授权 AURABOT_SELFTEST
  const store = fx.store
  store.upsertTask({ ...fx.task(), envNames: ['AURABOT_SELFTEST'] })
  await fx.runner.run(fx.taskId, 'manual', { confirm: true })
  const task = await waitFinish(store, fx.taskId)
  assert.equal(task.lastStatus, 'success')
  const [run] = store.runs()
  const log = await fx.runner.readLog(run.id)
  assert.match(log.content, /secret=\[已隐藏\]/, '授权变量已注入并被脱敏（未注入时会输出 none）')
  assert.doesNotMatch(log.content, /secret=none/, '授权变量确实注入了')
  assert.match(log.content, /host-env=absent/, '未授权与宿主环境不应注入')
  assert.doesNotMatch(log.content, /should-not-leak|inherited-host-value|granted-value/)
})

test('审批绑定来源与内容：源码变化自动撤销审批并停用任务', async (t) => {
  const fx = fixture(t, temp(t))
  const store = fx.store
  const repo = join(store.root, 'repos', 'local-test')
  fx.settings.enabled = true
  await fx.runner.run(fx.taskId, 'manual', { confirm: true })
  await waitFinish(store, fx.taskId)
  assert.ok(fx.task().approval, '确认后应记录审批')
  const fingerprint = fx.task().approval.fingerprint
  // 模拟用户启用定时（审批仍有效）
  store.upsertTask({ ...fx.task(), enabled: true })
  // 篡改脚本内容（模拟上游推送或本地工作区被改）
  writeFileSync(join(repo, 'selftest.js'), '// cron */1 * * * * *\nconsole.log("malicious-update")\n')
  await assert.rejects(fx.runner.run(fx.taskId, 'schedule'), /重新审查|重新确认|变化/)
  const after = fx.task()
  assert.equal(after.approval, null, '内容变化后审批应被撤销')
  assert.equal(after.enabled, false, '内容变化后定时应停用')
  assert.notEqual(fingerprint, undefined)
})

test('订阅地址或分支变化撤销全部任务审批', (t) => {
  const fx = fixture(t, temp(t))
  const store = fx.store
  store.upsertTask({ ...fx.task(), approval: { fingerprint: 'x', source: {}, approvedAt: new Date().toISOString() }, enabled: true })
  store.updateSubscription('local-test', { branch: 'dev' })
  const after = fx.task()
  assert.equal(after.approval, null)
  assert.equal(after.enabled, false)
  assert.match(after.revokedReason, /分支|重新/)
})

test('路径边界：拒绝仓库外的脚本与符号链接逃逸', (t) => {
  const fx = fixture(t, temp(t))
  const store = fx.store
  fx.settings.enabled = true
  store.upsertTask({ ...fx.task(), file: '../../../etc/passwd', approval: { fingerprint: 'x' } })
  assert.throws(() => fx.runner.fingerprint(fx.taskId), /越界/)
  store.upsertTask({ ...fx.task(), file: 'selftest.js', approval: { fingerprint: 'x' } })
})

test('日志脱敏：授权变量值与常见凭据字段不落明文', async (t) => {
  const fx = fixture(t, temp(t), {
    envs: [{ name: 'AURABOT_SELFTEST', value: 'super-secret-value' }],
    script: '// cron */1 * * * * *\nconsole.log("raw=" + process.env.AURABOT_SELFTEST)\nconsole.log("pt_key=abcdef123456789")\n',
  })
  fx.settings.enabled = true
  fx.store.upsertTask({ ...fx.task(), envNames: ['AURABOT_SELFTEST'] })
  await fx.runner.run(fx.taskId, 'manual', { confirm: true })
  const task = await waitFinish(fx.store, fx.taskId)
  assert.equal(task.lastStatus, 'success')
  const [run] = fx.store.runs()
  const log = await fx.runner.readLog(run.id)
  assert.doesNotMatch(log.content, /super-secret-value/)
  assert.doesNotMatch(log.content, /pt_key=abcdef123456789/)
  assert.match(log.content, /\[已隐藏\]/)
  assert.match(log.content, /selftest|raw=/)
})

test('并发上限：超过 maxConcurrent 时拒绝新任务', async (t) => {
  const fx = fixture(t, temp(t), { script: '// cron */1 * * * * *\nsetTimeout(() => console.log("slow-done"), 800)\n' })
  fx.settings.enabled = true
  fx.settings.maxConcurrent = 1
  await fx.runner.run(fx.taskId, 'manual', { confirm: true })
  // 同一任务运行中再次触发被拒
  await assert.rejects(fx.runner.run(fx.taskId, 'manual', { confirm: true }), /正在运行/)
  await waitFinish(fx.store, fx.taskId)
})

test('同步即写入定时任务：自动登记、幂等、识别 Cron、尊重用户关闭', async (t) => {
  const { execFileSync } = await import('node:child_process')
  const { writeFileSync } = await import('node:fs')
  const root = temp(t)
  const upstream = join(root, 'upstream')
  mkdirSync(upstream, { recursive: true })
  const git = (...args) => execFileSync('git', args, { cwd: upstream, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] })
  git('init', '-q'); git('config', 'user.email', 't@t'); git('config', 'user.name', 't')
  writeFileSync(join(upstream, 'jd_bean.js'), '// cron 5 9 * * *\nconsole.log("a")\n')
  writeFileSync(join(upstream, 'jx_sign.js'), '/* cron 10 20 * * * */\nconsole.log("b")\n')
  writeFileSync(join(upstream, 'helper.js'), 'console.log("no cron")\n')
  git('add', '-A'); git('commit', '-qm', 'init')

  const dataDir = join(root, 'data')
  const store = createStore(dataDir)
  store.addSubscription({ id: 'local', name: '本地源', url: 'https://example.com/local.git', branch: 'main', whitelist: '', blacklist: '', extensions: 'js', enabled: true })
  const repo = join(dataDir, 'repos', 'local')
  execFileSync('git', ['clone', '-q', upstream, repo], { encoding: 'utf8' })
  writeFileSync(join(dataDir, 'repos', 'local.source'), 'https://example.com/local.git#main')

  const runner = createRunner({ store, log: null, settings: () => ({ enabled: false }) })
  t.after(() => runner.dispose())

  const first = await runner.sync('local')
  assert.equal(first.added, 2, '识别到 Cron 的 2 个脚本应自动登记为任务')
  assert.equal(first.scripts, 3)
  const tasks = store.state().tasks
  assert.equal(tasks.length, 2)
  assert.deepEqual(tasks.map((x) => x.cron).sort(), ['10 20 * * *', '5 9 * * *'])
  assert.ok(tasks.every((x) => x.enabled === false && x.approval === null), '自动建任务不等于授权执行')

  const second = await runner.sync('local')
  assert.equal(second.added, 0, '重复同步不应重复建任务')
  assert.equal(store.state().tasks.length, 2)

  store.updateSubscription('local', { autoAddCron: false })
  const third = await runner.sync('local')
  assert.equal(third.added, 0)
  assert.equal(store.state().subscriptions.find((s) => s.id === 'local').autoAddCron, false, '用户主动关闭后同步不得偷偷打开')
})

test('旧状态迁移：内置订阅升级为自动写入，用户改过的不覆盖', (t) => {
  const legacyDir = temp(t)
  writeFileSync(join(legacyDir, 'state.json'), JSON.stringify({
    subscriptions: [
      { id: 'jdpro', name: 'jd', url: 'https://github.com/cyuni1996/jdpro.git', branch: 'main', extensions: 'js py sh', enabled: true, autoAddCron: false },
      { id: 'custom', name: 'c', url: 'https://example.com/c.git', branch: 'main', extensions: 'js', enabled: true, autoAddCron: false, updatedAt: '2026-01-01T00:00:00.000Z' },
    ],
    tasks: [],
  }))
  const legacy = createStore(legacyDir)
  const jd = legacy.state().subscriptions.find((s) => s.id === 'jdpro')
  const custom = legacy.state().subscriptions.find((s) => s.id === 'custom')
  assert.equal(jd.autoAddCron, true, '未被用户改过的内置订阅应升级')
  assert.equal(custom.autoAddCron, false, '用户保存过的订阅不应被覆盖')
})

test('网络不可用时回退本地源码，仍登记定时任务', async (t) => {
  const { execFileSync } = await import('node:child_process')
  const { writeFileSync } = await import('node:fs')
  const root = temp(t)
  const upstream = join(root, 'upstream')
  mkdirSync(upstream, { recursive: true })
  const git = (...args) => execFileSync('git', args, { cwd: upstream, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] })
  git('init', '-q'); git('config', 'user.email', 't@t'); git('config', 'user.name', 't')
  writeFileSync(join(upstream, 'jd_bean.js'), '// cron 5 9 * * *\nconsole.log("a")\n')
  git('add', '-A'); git('commit', '-qm', 'init')

  const dataDir = join(root, 'data')
  const store = createStore(dataDir)
  // 故意指向不可达地址，模拟断网/仓库下线；本地已有克隆
  store.addSubscription({ id: 'local', name: '本地源', url: 'https://127.0.0.1:1/none.git', branch: 'main', whitelist: '', blacklist: '', extensions: 'js', enabled: true })
  const repo = join(dataDir, 'repos', 'local')
  execFileSync('git', ['clone', '-q', upstream, repo], { encoding: 'utf8' })
  // 克隆来源是本地目录，需把 origin 改到不可达地址，才能模拟「远端挂了但本地有源码」
  execFileSync('git', ['-C', repo, 'remote', 'set-url', 'origin', 'https://127.0.0.1:1/none.git'], { encoding: 'utf8' })
  writeFileSync(join(dataDir, 'repos', 'local.source'), 'https://127.0.0.1:1/none.git#main')

  const runner = createRunner({ store, log: null, settings: () => ({ enabled: false }) })
  t.after(() => runner.dispose())

  const result = await runner.sync('local')
  assert.equal(result.ok, true)
  assert.equal(result.offline, true, '拉取失败但有本地源码时应标记离线')
  assert.equal(result.added, 1, '仍应按本地源码登记任务')
  assert.equal(store.state().subscriptions.find((s) => s.id === 'local').lastSyncStatus, 'offline')
  assert.equal(store.state().tasks.length, 1)
  assert.equal(store.state().tasks[0].enabled, false, '离线登记的任务同样默认停用')
})

test('无本地源码且拉取失败时明确报错', async (t) => {
  const root = temp(t)
  const store = createStore(join(root, 'data'))
  store.addSubscription({ id: 'gone', name: '坏源', url: 'https://127.0.0.1:1/none.git', branch: 'main', whitelist: '', blacklist: '', extensions: 'js', enabled: true })
  const runner = createRunner({ store, log: null, settings: () => ({ enabled: false }) })
  t.after(() => runner.dispose())
  await assert.rejects(runner.sync('gone'), /拉取失败/)
  assert.equal(store.state().subscriptions.find((s) => s.id === 'gone').lastSyncStatus, 'error')
})

test('同步即对齐：删除本订阅已消失的脚本任务，且不影响其它订阅', async (t) => {
  const { execFileSync } = await import('node:child_process')
  const { writeFileSync } = await import('node:fs')
  const root = temp(t)
  const git = (cwd, ...a) => execFileSync('git', a, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] })
  const makeUpstream = (name, files) => {
    const dir = join(root, name)
    mkdirSync(dir, { recursive: true })
    git(dir, 'init', '-q'); git(dir, 'config', 'user.email', 't@t'); git(dir, 'config', 'user.name', 't')
    for (const [f, c] of Object.entries(files)) writeFileSync(join(dir, f), c)
    git(dir, 'add', '-A'); git(dir, 'commit', '-qm', 'init')
    return dir
  }
  const upA = makeUpstream('upA', { 'jd_a.js': '// cron 1 8 * * *\nconsole.log(1)\n', 'jd_b.js': '// cron 2 8 * * *\nconsole.log(2)\n' })
  const upB = makeUpstream('upB', { 'jd_x.js': '// cron 3 8 * * *\nconsole.log(3)\n' })

  const dataDir = join(root, 'data')
  const store = createStore(dataDir)
  store.addSubscription({ id: 'src-a', name: 'A', url: 'https://example.com/repo-src-a.git', branch: 'main', extensions: 'js', enabled: true })
  store.addSubscription({ id: 'src-b', name: 'B', url: 'https://example.com/repo-src-b.git', branch: 'main', extensions: 'js', enabled: true })
  for (const [id, up] of [['src-a', upA], ['src-b', upB]]) {
    execFileSync('git', ['clone', '-q', up, join(dataDir, 'repos', id)], { encoding: 'utf8' })
    writeFileSync(join(dataDir, 'repos', `${id}.source`), `https://example.com/repo-${id}.git#main`)
  }

  const runner = createRunner({ store, log: null, settings: () => ({ enabled: false }) })
  t.after(() => runner.dispose())
  await runner.sync('src-a'); await runner.sync('src-b')
  assert.equal(store.state().tasks.length, 3)

  // 上游 A 删除 jd_b.js 并新增 jd_c.js
  execFileSync('git', ['rm', '-q', 'jd_b.js'], { cwd: upA })
  writeFileSync(join(upA, 'jd_c.js'), '// cron 4 8 * * *\nconsole.log(4)\n')
  git(upA, 'add', '-A'); git(upA, 'commit', '-qm', 'change')

  const result = await runner.sync('src-a')
  assert.equal(result.added, 1, '新增脚本应建任务')
  assert.equal(result.removed, 1, '已消失脚本的任务应被清理')
  const files = store.state().tasks.map((x) => x.file).sort()
  assert.deepEqual(files, ['jd_a.js', 'jd_c.js', 'jd_x.js'], 'B 订阅的任务不受影响')
  assert.equal(store.state().tasks.some((x) => x.file === 'jd_b.js'), false)

  // 用户关闭自动清理后，同步不再删除
  store.updateSubscription('src-a', { autoDelCron: false })
  execFileSync('git', ['rm', '-q', 'jd_c.js'], { cwd: upA })
  git(upA, 'add', '-A'); git(upA, 'commit', '-qm', 'rm c')
  const second = await runner.sync('src-a')
  assert.equal(second.removed, 0, '用户关闭清理后不得删除任务')
  assert.equal(store.state().tasks.some((x) => x.file === 'jd_c.js'), true)
})

test('Cron 解析：逗号列表、快捷语法、注释与引号', () => {
  assert.equal(parseCron('0 6,18 * * *').raw, '0 6,18 * * *')
  assert.equal(parseCron('@daily').raw, '0 0 * * *')
  assert.equal(parseCron('@hourly').raw, '0 * * * *')
  assert.equal(parseCron('1 1 1 1 *; 仅执行一次').raw, '1 1 1 1 *')
  assert.equal(parseCron('"15 2 * * *"').raw, '15 2 * * *')
  assert.throws(() => parseCron(''), /不能为空/)
})

test('Cron 提取：兼容各仓库真实写法', () => {
  assert.equal(extractCron('// cron */1 * * * * *'), '*/1 * * * * *')
  assert.equal(extractCron('/* cron 31 11 * * *\n * next */'), '31 11 * * *')
  assert.equal(extractCron('const cron = "15 2 * * *"'), '15 2 * * *')
  assert.equal(extractCron('cron:1 1 1 1 *'), '1 1 1 1 *')
  // 注释末尾带文件名（ql-public 常见）
  assert.equal(extractCron(' * cron 17 18 * * *  gqft.js'), '17 18 * * *')
  // 注释末尾带中文说明
  assert.equal(extractCron(' * cron 0 6,18 * * *  好奇车生活.js'), '0 6,18 * * *')
  assert.equal(extractCron('# 定时：30 8 * * *'), '30 8 * * *')
  // 没有 cron 声明时不应误报
  assert.equal(extractCron('function Env(o,t){class s{}}'), '')
})

test('重复添加任务不报错：已存在时更新 Cron 并停用待确认', async (t) => {
  const { execFileSync } = await import('node:child_process')
  const { writeFileSync } = await import('node:fs')
  const root = temp(t)
  const up = join(root, 'up')
  mkdirSync(up, { recursive: true })
  const git = (...a) => execFileSync('git', a, { cwd: up, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] })
  git('init', '-q'); git('config', 'user.email', 't@t'); git('config', 'user.name', 't')
  writeFileSync(join(up, 'a.js'), '// cron 1 8 * * *\nconsole.log(1)\n')
  git('add', '-A'); git('commit', '-qm', 'init')

  const dataDir = join(root, 'data')
  const store = createStore(dataDir)
  store.addSubscription({ id: 'src-a', name: 'A', url: 'https://example.com/repo-src-a.git', branch: 'main', extensions: 'js', enabled: true })
  execFileSync('git', ['clone', '-q', up, join(dataDir, 'repos', 'src-a')], { encoding: 'utf8' })
  writeFileSync(join(dataDir, 'repos', 'src-a.source'), 'https://example.com/repo-src-a.git#main')
  const runner = createRunner({ store, log: null, settings: () => ({ enabled: false }) })
  t.after(() => runner.dispose())
  await runner.sync('src-a')

  const [task] = store.state().tasks
  // 模拟面板再次点「添加」：同步后改为更新而非抛错
  const updated = store.upsertTask({ ...task, cron: '5 9 * * *', enabled: false, revokedReason: 'Cron 已修改，请重新确认后启用' })
  assert.equal(updated.cron, '5 9 * * *')
  assert.equal(store.state().tasks.length, 1, '不应产生重复任务')
  assert.equal(updated.enabled, false)
})

test('一键开启：逐个授权各自指纹，可再次全部停用', async (t) => {
  const { execFileSync } = await import('node:child_process')
  const { writeFileSync } = await import('node:fs')
  const root = temp(t)
  const up = join(root, 'up')
  mkdirSync(up, { recursive: true })
  const git = (...a) => execFileSync('git', a, { cwd: up, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] })
  git('init', '-q'); git('config', 'user.email', 't@t'); git('config', 'user.name', 't')
  writeFileSync(join(up, 'a.js'), '// cron 1 8 * * *\nconsole.log(1)\n')
  writeFileSync(join(up, 'b.js'), '// cron 2 8 * * *\nconsole.log(2)\n')
  git('add', '-A'); git('commit', '-qm', 'init')

  const dataDir = join(root, 'data')
  const store = createStore(dataDir)
  store.addSubscription({ id: 'src-a', name: 'A', url: 'https://example.com/repo-src-a.git', branch: 'main', extensions: 'js', enabled: true })
  execFileSync('git', ['clone', '-q', up, join(dataDir, 'repos', 'src-a')], { encoding: 'utf8' })
  writeFileSync(join(dataDir, 'repos', 'src-a.source'), 'https://example.com/repo-src-a.git#main')
  const runner = createRunner({ store, log: null, settings: () => ({ enabled: false }) })
  t.after(() => runner.dispose())
  await runner.sync('src-a')
  assert.equal(store.state().tasks.length, 2)

  for (const item of store.state().tasks) {
    runner.authorize(item.id)
    store.upsertTask({ ...store.state().tasks.find((x) => x.id === item.id), enabled: true })
  }
  assert.equal(store.state().tasks.every((x) => x.enabled), true)
  const fps = store.state().tasks.map((x) => x.approval.fingerprint)
  assert.equal(new Set(fps).size, 2, '每个任务的审批指纹应各不相同')

  for (const x of store.state().tasks) store.upsertTask({ ...x, enabled: false })
  assert.equal(store.state().tasks.every((x) => !x.enabled && x.approval), true, '停用不丢审批')
})
