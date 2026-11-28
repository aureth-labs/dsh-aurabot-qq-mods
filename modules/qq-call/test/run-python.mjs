// 跑 Python 侧的纯逻辑测试（test/logic.test.py）。
// CI 的 ubuntu 自带 python3，本地 Windows 一般是 python；都没有就跳过，不让模块测试变红。
import { spawnSync } from 'node:child_process'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = fileURLToPath(new URL('..', import.meta.url))
const script = join(root, 'test', 'logic.test.py')
const candidates = process.platform === 'win32' ? ['python', 'python3', 'py'] : ['python3', 'python']

for (const exe of candidates) {
  const probe = spawnSync(exe, ['-c', 'import sys; print(sys.version_info[0])'], { encoding: 'utf8' })
  if (probe.status !== 0 || !/3/.test(probe.stdout || '')) continue
  console.log(`[qq-call] Python 逻辑测试：${exe} ${script}`)
  const run = spawnSync(exe, [script], { cwd: root, stdio: 'inherit' })
  process.exit(run.status ?? 1)
}

console.log('[qq-call] 跳过 Python 逻辑测试：这台机器没有可用的 python3')
process.exit(0)
