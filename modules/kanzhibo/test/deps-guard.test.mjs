import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'

// 依赖清单守卫：工厂模块(foo(deps))里用到的“注入名”，必须在 `{...}=deps`
// 的解构里，或在本文件有 const/let/function/class/import 声明。
// 目的：专治重构时“函数里用了某个名字、但 index 没注入”的漏依赖（真机才炸）。
const DEP = [
  'ctx','api','note','sleep','saveState','loadState','dayKey','roomKeyOf','currentUrl','evalJs','pageText','chatLines','panelText',
  'clicker','ax','clickBy','choosePoint','describeHit','axSig','normalizeSpec','collapseNested','pickUnique','sameSig','badgeRowState',
  'taskProgressFromText','plus100FromText','badgeHintsFromText','badgeTaskRowFromText','BADGE_CHAT_RE','EVIDENCE_WAIT_MS',
  'ensureViewport','ensureBrowser','closeBrowser','livePort','attach','showWindow','openLogin','loginState','inWindow','clampCheckSec',
  'giveUpRoomsDiffer','badgeSent','doBadge','badgeReject','closeTaskPanel','notifyOwner','dropPending','journal','cleanShots','getBusy','setBusy',
  'getCommentedDay','setCommentedDay','setCommentedUrl','askOwner','gate','sendComment','sendGift','prepareGift','stripQuotes','fromOwnerDm',
  'SAY_MAX_CHARS','sayWaitSec','markSaySent','pushSayLog','recentOps','fmtStep','withBusy','stopAll','tick',
  'enterNow','stopNow','statusLine','selfCheck','confirmPending','cancelPending','isLiveTarget','LIVE_RE','BADGE_ENTRY_SPEC','BADGE_CONFIRM_SPEC','BADGE_CONFIRM_TEXTS','TASK_ENTRY_EXPR','GIFT_CELL_SPEC','GIFT_CONFIRM_SPEC','allOwnerTurn','ensureInRoom','waitRoomReady','endedSignals','enterFromProfile','Cdp','getJson','profileDir','navigate','ownerChat',
]

const LIB = new URL('../lib/', import.meta.url)
function walk(dir) {
  const out = []
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    if (e.isDirectory()) out.push(...walk(new URL(e.name + '/', dir)))
    else if (e.name.endsWith('.mjs')) out.push(new URL(e.name, dir))
  }
  return out
}
function declaredNames(src) {
  const d = new Set()
  for (const m of src.matchAll(/const\s*\{([\s\S]*?)\}\s*=\s*deps/g)) {
    for (const part of m[1].split(',')) {
      const n = part.trim().split(':')[0].trim()
      if (n) d.add(n)
    }
  }
  for (const m of src.matchAll(/(?:const|let|var|function|class)\s+([A-Za-z_$][\w$]*)/g)) d.add(m[1])
  for (const m of src.matchAll(/export\s+function\s+[A-Za-z_$][\w$]*\s*\(\s*\{([\s\S]*?)\}\s*\)/g)) { for (const part of m[1].split(',')) { const n = part.trim().split(':')[0].trim(); if (n) d.add(n) } }
  for (const m of src.matchAll(/import\s*\{([^}]*)\}/g)) for (const part of m[1].split(',')) d.add(part.trim().split(/\s+as\s+/).pop())
  for (const m of src.matchAll(/function\s+[A-Za-z_$][\w$]*\s*\(([^)]*)\)/g)) for (const p of m[1].split(',')) d.add(p.trim().split('=')[0].trim())
  return d
}

test('lib 工厂：用到的依赖名都已声明/注入（防漏依赖）', () => {
  const offenders = []
  for (const u of walk(LIB)) {
    const raw = readFileSync(u, 'utf8')
    const src = raw.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '')
    if (!/= deps/.test(raw) && !/export\s+function\s+[A-Za-z_$][\w$]*\s*\(\s*\{/.test(raw)) continue
    const local = declaredNames(raw)
    const miss = DEP.filter((n) => !local.has(n) && new RegExp('\\b' + n + '\\b').test(src))
    if (miss.length) offenders.push({ file: u.pathname.split('/lib/').pop(), miss })
  }
  assert.deepEqual(offenders, [], '以下模块用了依赖但未注入：' + JSON.stringify(offenders))
})
