// 在测试环境注入宿主提供的 globalThis.aurabot（真实宿主由插件注入）
// 没有它，lib/site.mjs 里的 globalThis.aurabot.lib('core/store.js') 会报 undefined。
import { mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

if (!globalThis.aurabot) {
  const dataRoot = join(tmpdir(), 'aurabot-test-data')
  mkdirSync(dataRoot, { recursive: true })
  globalThis.aurabot = {
    // 只需要 dataDir；其它内部文件本项目测试用不到
    lib: (key) => {
      if (String(key) === 'core/store.js') {
        return { dataDir: (...parts) => join(dataRoot, ...parts) }
      }
      // 其余内部文件属于 Aurabot 插件本体，不在本仓库里。
      // 依赖它们的测试（send-hook / verify 的个别用例）只能在宿主环境跑，这里给个空壳。
      return {}
    },
    src: '',
    version: '1.2.0',
    apiVersion: 1,
    modules: {},
  }
}
