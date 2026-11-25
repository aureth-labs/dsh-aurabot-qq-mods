// run() 的超时：子进程挂住时必须中止，而且必须等到它真的退出再 reject
// （reject 之后调用方会 rm -rf 它正在写的目录，进程还在跑就会两边抢文件），
// 错误文案也要说「超时」，而不是「退出码 null」。
// 用法：node test/run-timeout.mjs
import { run } from '../lib/install.mjs'

const ok = (cond, label, extra) => {
  if (cond) { console.log('OK ' + label + (extra ? ' - ' + extra : '')); return }
  console.error('FAIL ' + label + (extra ? ' - ' + extra : ''))
  process.exitCode = 1
}

// ---- 正常路径 ----
const good = await run(process.execPath, ['-e', 'process.stdout.write("hi")'], 10000)
ok(good.out === 'hi', '正常命令 resolve 并带回 stdout', JSON.stringify(good.out))

// ---- 非 0 退出：带退出码 ----
let badErr = null
try { await run(process.execPath, ['-e', 'process.exit(3)'], 10000) } catch (e) { badErr = e }
ok(badErr !== null, '非 0 退出 reject')
ok(/退出码 3/.test(String(badErr && badErr.message)), '错误文案带退出码', String(badErr && badErr.message))

// ---- 超时：脚本自己活 30 秒，只给 500ms ----
const started = Date.now()
let timeoutErr = null
try { await run(process.execPath, ['-e', 'setTimeout(function () {}, 30000)'], 500) } catch (e) { timeoutErr = e }
const spent = Date.now() - started
ok(timeoutErr !== null, '超时必须 reject')
ok(/已中止/.test(String(timeoutErr && timeoutErr.message)), '错误文案说「已中止」', String(timeoutErr && timeoutErr.message))
ok(!/退出码/.test(String(timeoutErr && timeoutErr.message)), '错误文案不是「退出码 null」', String(timeoutErr && timeoutErr.message))
ok(spent >= 500, '至少等满超时时间', spent + 'ms')
// 上限必须卡在 kill 之后很快落地：若实现退化成「等满 5 秒 grace 再报」，这条会红。
ok(spent < 2000, 'close 先到就先报错，不等 grace 上限', spent + 'ms')

// ---- 跑不起来的命令 ----
let spawnErr = null
try { await run(process.execPath + '-does-not-exist', ['-v'], 5000) } catch (e) { spawnErr = e }
ok(spawnErr !== null && /跑不起来/.test(String(spawnErr.message)), '跑不起来的命令 reject 并可读', String(spawnErr && spawnErr.message).slice(0, 60))

console.log(process.exitCode ? '有断言失败' : '全部通过')
