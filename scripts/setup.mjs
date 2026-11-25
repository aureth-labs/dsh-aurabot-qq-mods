// 一次装齐各模块的依赖。模块的 node_modules 是编辑器认 @types/node、跑 tsc 的前提，
// 缺了它不是代码有问题，而是满屏「找不到 fetch / Response」。
// 用法：npm run setup

import { execFileSync } from 'node:child_process'
import { existsSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { MODULES_DIR } from './lib.mjs'

const dirs = readdirSync(MODULES_DIR, { withFileTypes: true })
  .filter((e) => e.isDirectory() && !/^[_.]/.test(e.name))
  .map((e) => ({ id: e.name, dir: join(MODULES_DIR, e.name) }))
  .filter((m) => existsSync(join(m.dir, 'package.json')))
  .sort((a, b) => a.id.localeCompare(b.id))

let installed = 0
// 从 `npm run setup` 里再调 npm 时，父进程会把 npm_config_* 一起带下去，
// npm 11 会拿这些环境变量当显式配置（报 --allow-scripts 不允许），所以先清掉。
const env = Object.fromEntries(Object.entries(process.env).filter(([k]) => !/^npm_config_/i.test(k)))

for (const { id, dir } of dirs) {
  // 有 lock 用 ci（严格按锁装）；没有就 install，但别顺手生成一个新的 lock。
  const args = existsSync(join(dir, 'package-lock.json'))
    ? ['ci', '--ignore-scripts', '--no-audit', '--no-fund']
    : ['install', '--ignore-scripts', '--no-audit', '--no-fund', '--no-package-lock']
  console.log(`[setup] ${id}`)
  execFileSync('npm', args, { cwd: dir, env, stdio: ['ignore', 'inherit', 'inherit'], shell: process.platform === 'win32' })
  installed++
}

console.log(`[setup] ${installed} 个模块的依赖已就绪`)
