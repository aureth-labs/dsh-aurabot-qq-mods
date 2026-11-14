import { existsSync, readFileSync, writeFileSync, renameSync, mkdirSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { createState, loadState } from './growth.mjs'

export function openStore(dir, now) {
  mkdirSync(dir, { recursive: true })
  const file = join(dir, 'state.json')
  const save = value => {
    const tmp = join(dir, 'state.json.tmp')
    try {
      writeFileSync(tmp, JSON.stringify(value, null, 2) + '\n', { mode: 0o600 })
      renameSync(tmp, file)
    } catch (error) {
      try { rmSync(tmp, { force: true }) } catch { /* 原存档不动 */ }
      throw error
    }
  }
  // 读坏了就报错停下，绝不用空状态覆盖原存档。
  const state = existsSync(file) ? loadState(JSON.parse(readFileSync(file, 'utf8')), now) : createState(now)
  if (!existsSync(file)) save(state)
  return { state, save }
}
