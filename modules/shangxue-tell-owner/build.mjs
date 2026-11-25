// package.json 是模块配置的唯一来源；每次构建生成 module.json，并删掉 PR.md。

import { execFileSync } from 'node:child_process'
import { copyFileSync, existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = dirname(fileURLToPath(import.meta.url))
const OUT = join(ROOT, 'lib')
const pkg = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8'))

const manifest = {
  id: pkg.name,
  name: pkg.displayName || pkg.name,
  version: pkg.version,
  description: pkg.description,
  category: pkg.category,
  tags: pkg.tags || [],
  platforms: pkg.platforms || ['qq'],
  author: pkg.author,
  license: pkg.license,
  api: pkg.pluginApi,
  minPluginVersion: pkg.minPluginVersion,
  requires: pkg.requires || [],
  capabilities: pkg.pluginCapabilities || [],
  ...(pkg.panel ? { panel: pkg.panel } : {}),
  ...(pkg.build ? { build: pkg.build } : {}),
}

for (const key of ['category', 'author', 'minPluginVersion']) {
  if (manifest[key] === undefined || manifest[key] === '') throw new Error(`package.json 缺 ${key}`)
}
if (!Number.isInteger(pkg.pluginApi) || pkg.pluginApi < 1) throw new Error('package.json 缺 pluginApi（整数）')
writeFileSync(join(ROOT, 'module.json'), JSON.stringify(manifest, null, 2) + '\n')
rmSync(join(ROOT, 'PR.md'), { force: true })

rmSync(OUT, { recursive: true, force: true })
const TSC = join(ROOT, 'node_modules', 'typescript', 'bin', 'tsc')
// 没装依赖时 tsc 不存在，编辑器这类「找不到 fetch/Response」的报错也是同一个原因。
if (!existsSync(TSC)) throw new Error('没装依赖：先进本模块目录跑 npm ci')
execFileSync(process.execPath, [TSC, '-p', join(ROOT, 'tsconfig.json')], { stdio: 'inherit' })

if (existsSync(join(ROOT, 'panel.js'))) copyFileSync(join(ROOT, 'panel.js'), join(OUT, 'panel.js'))
writeFileSync(join(OUT, 'index.mjs'), "export * from './index.js'\nexport { default } from './index.js'\n")
writeFileSync(join(OUT, 'package.json'), JSON.stringify({ type: 'module', private: true }, null, 2) + '\n')

console.log('[build] module.json 已从 package.json 同步；src/ → lib/ 完成')
