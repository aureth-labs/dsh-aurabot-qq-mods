// 校验全部模块。node scripts/check.mjs [--base <git引用>]
// 带 --base 时额外检查：改过的模块必须升版本。已发布的版本任何时候都不能再动。

import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { catalogFresh } from './catalog.mjs'
import { BUILTINS, ROOT, checkModule, checkRevoked, checkTestCoverage, compareVersions, listModules, readManifest, tagOf } from './lib.mjs'

const git = (...args) => execFileSync('git', args, { cwd: ROOT, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim()
const baseIndex = process.argv.indexOf('--base')
const base = baseIndex > 0 ? process.argv[baseIndex + 1] : ''
const mods = listModules()
const known = new Set([...BUILTINS, ...mods.map((m) => m.id)])
let failed = false

/** 这个模块是不是本次新增的（base 上还没有它）。没带 --base 时判断不了，一律当老模块。 */
function isNewModule(mod) {
  if (!base) return false
  try {
    git('show', `${base}:modules/${mod.id}/module.json`)
    return false
  } catch (error) {
    return true
  }
}

function versionErrors(mod) {
  const version = readManifest(mod.dir).version
  const tag = tagOf(mod.id, version)
  if (git('tag', '-l', tag)) return git('diff', '--name-only', tag, 'HEAD', '--', `modules/${mod.id}`) ? [`${version} 已经发布过，内容又变了：要升版本号`] : []
  if (!base || !git('diff', '--name-only', `${base}...HEAD`, '--', `modules/${mod.id}`)) return []
  let before = ''
  try { before = JSON.parse(git('show', `${base}:modules/${mod.id}/module.json`)).version } catch (error) { return [] } // 新模块
  return compareVersions(version, before) > 0 ? [] : [`模块改了，version 要比 ${before} 高`]
}

for (const mod of mods) {
  const { errors, warnings } = checkModule(mod, known)
  // 新模块必须带测试：这次提交了新模块却没 test/，check 直接红
  errors.push(...checkTestCoverage(mod.dir, { required: isNewModule(mod) }))
  if (!errors.length) errors.push(...versionErrors(mod))
  for (const w of warnings) console.log(`⚠ ${mod.id}：${w}`)
  for (const e of errors) console.error(`✗ ${mod.id}：${e}`)
  if (errors.length) failed = true
  else console.log(`✓ ${mod.id}`)
}
for (const e of checkRevoked(JSON.parse(readFileSync(join(ROOT, 'revoked.json'), 'utf8')))) { console.error(`✗ ${e}`); failed = true }
if (!catalogFresh()) { console.error('✗ modules/README.md 过期了：运行 npm run catalog'); failed = true }
console.log(`检查了 ${mods.length} 个模块`)
process.exit(failed ? 1 : 0)
