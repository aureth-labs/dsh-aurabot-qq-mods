// 自己办活的桥：把统计类的活交给模块自带的 Python 执行器（lib/executor.py）。
// 所有路径都可配置/推导，不写死任何机器路径。

import { spawnSync } from 'node:child_process'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))

// 从当前 node 的运行路径推出同安装下的 bundled python
function bundledPython() {
  try {
    const nodeBin = process.execPath // .../dependencies/node/bin/node.exe
    const deps = dirname(dirname(dirname(nodeBin))) // .../dependencies
    return join(deps, 'python', 'python.exe')
  } catch {
    return 'python'
  }
}

// 只有这些确定性句式才自己试，其余交回主人
const SAFE =
  /(最贵|最值钱|最便宜|最低价|多少台|几台|总共.*设备|设备.*总数|合计|总额|总价|加起来|平均|中位数|哪家公司|哪个公司|买得最多)/

/** 试着自己办，返回 {ok, result}。settings 里可给 pythonPath / tablePath。 */
export function tryHandle(text, settings = {}) {
  const s = String(text || '')
  if (!SAFE.test(s)) return { ok: false, result: '' }

  const py = settings.pythonPath || bundledPython()
  const script = join(HERE, 'executor.py')
  const table = settings.tablePath || ''

  try {
    const r = spawnSync(
      py,
      ['-X', 'utf8', script, s, table],
      {
        encoding: 'utf8',
        timeout: 30_000,
        windowsHide: true,
        env: { ...process.env, PYTHONIOENCODING: 'utf-8' },
      },
    )
    if (r.error || r.status !== 0) return { ok: false, result: '' }
    const out = (r.stdout || '').trim().split('\n').pop()
    const d = JSON.parse(out)
    return { ok: !!d.ok, result: String(d.result || '') }
  } catch {
    return { ok: false, result: '' }
  }
}
