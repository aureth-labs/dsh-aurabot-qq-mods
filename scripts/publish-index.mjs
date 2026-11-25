// 生成 index.json。node scripts/publish-index.mjs --release dist/release.json --previous 旧index.json --out index.json

import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { ROOT, listModules, mergeIndex } from './lib.mjs'

const arg = (name) => { const i = process.argv.indexOf(name); return i > 0 ? process.argv[i + 1] : '' }
const read = (path) => (path && existsSync(path) ? JSON.parse(readFileSync(path, 'utf8')) : null)
const repo = process.env.GITHUB_REPOSITORY || 'aureth-labs/dsh-aurabot-qq-mods'

const index = mergeIndex({
  previous: read(arg('--previous')),
  built: read(arg('--release')) || [],
  present: listModules().map((m) => m.id),
  revoked: read(join(ROOT, 'revoked.json')) || [],
  assetsBase: `https://github.com/${repo}/releases/download/`,
  now: new Date().toISOString(),
  commit: process.env.GITHUB_SHA || '',
})
writeFileSync(arg('--out') || 'index.json', JSON.stringify(index, null, 2) + '\n')
console.log(`索引里有 ${index.modules.length} 个模块`)
