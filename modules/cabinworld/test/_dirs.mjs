// 测试用的目录约定：默认跟着模块数据目录 modules-data/cabinworld（游戏和存档都在那儿），可用环境变量覆盖。
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { CORE, TOOL_SPECS } from '../lib/tools.mjs'
import { hostDir } from '../lib/host.mjs'

const HERE = path.dirname(fileURLToPath(import.meta.url))
// 测试默认连模块数据目录里的游戏（模块目录只放代码，游戏和存档在 modules-data/<id>/）。
// 从插件安装位置跑时它对得上；从源码仓库跑时那里没有 modules-data，
// 所以要再试一次本机 DSH 的插件数据目录，否则所有跟桥清单有关的断言都会静默退化。
const HOME = process.env.USERPROFILE || process.env.HOME || ''
function pickGameDir() {
  const cands = [
    process.env.CABIN_GAME_DIR,
    path.join(HERE, '..', '..', '..', 'modules-data', 'cabinworld'),
    HOME ? path.join(HOME, '.dsh', 'plugins-data', 'aurabot', 'modules-data', 'cabinworld') : '',
  ]
  for (const c of cands) {
    if (!c) continue
    try { if (fs.existsSync(path.join(c, 'bridge'))) return c } catch (e) { /* 试下一个 */ }
  }
  return cands[1]
}
export const GAME_DIR = pickGameDir()
export const BRIDGE_JSON = process.env.CABIN_BRIDGE_JSON || path.join(GAME_DIR, 'data', 'bridge.json')

// 桥清单里到底有哪些工具名（优先副本 bridge-host，其次官方 bridge；都读不到就用模块的离线兜底清单）。
// 不在这里另抄一份名单：名单只有 lib/tools.mjs 那一份。
export function bridgeToolNames() {
  for (const dir of [hostDir(GAME_DIR), path.join(GAME_DIR, 'bridge')]) {
    try {
      const tools = JSON.parse(fs.readFileSync(path.join(dir, 'openai-tools.json'), 'utf8')).tools
      const names = (Array.isArray(tools) ? tools : []).map(function (t) { return t && t.function && t.function.name }).filter(Boolean)
      if (names.length) return names
    } catch (e) { /* 没有这份清单就试下一个 */ }
  }
  return TOOL_SPECS.map(function (s) { return s.name })
}

// 私聊 / 自动生活应该挂上的名字集合 = CORE 与桥清单的交集。
// 桥被降级成未打补丁的官方桥时 sleep/toolpose 不在清单里，这里自然变成 11 个，和产品行为一致。
export function expectedCoreNames() {
  const names = bridgeToolNames()
  return CORE.filter(function (n) { return names.indexOf(n) >= 0 })
}
