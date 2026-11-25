// 重复插件清理：只动 modules/ 里「明显不该在」的文件夹，全部归档不硬删。
// 面板按钮是宿主按 modules/ 文件夹 + 仍在跑的模块算出来的，所以：
//   1) 把重复/无效的文件夹挪走 → 按钮不再出现
//   2) 对「文件夹已没了但还在跑」的模块调 stop → 它的按钮立刻消失
// 不碰：内置模块、正在用的 canonical 文件夹、modules-data 里的数据、config 里的 key。
import { readdirSync, readFileSync, existsSync, renameSync, cpSync, rmSync, mkdirSync, writeFileSync, statSync } from 'node:fs'
import { join } from 'node:path'

const ENTRY = ['index.mjs', 'index.js', 'index.cjs']
const ID_RE = /^[a-z][a-z0-9-]{1,39}$/

const readDef = (dir) => {
  for (const f of ENTRY) {
    const p = join(dir, f)
    if (!existsSync(p)) continue
    try {
      const src = readFileSync(p, 'utf8')
      const m = src.match(/id\s*:\s*['"`]([^'"`]+)['"`]/)
      return { entry: f, id: m ? m[1] : '', mtime: statSync(p).mtimeMs }
    } catch { return { entry: f, id: '', mtime: 0 } }
  }
  return null
}
const readJson = (dir) => {
  try { return JSON.parse(readFileSync(join(dir, 'module.json'), 'utf8')) } catch { return null }
}

/** 只看不动：返回 { keep, move, stop, notes } */
export function scan(api) {
  const root = String(api?.core?.modules?.dir?.() || '')
  const notes = []
  const move = []
  const keep = []
  if (!root || !existsSync(root)) return { ok: false, message: '找不到 modules 目录', keep, move, stop: [], notes }
  let names = []
  try { names = readdirSync(root, { withFileTypes: true }) } catch (e) { return { ok: false, message: '读不了 modules 目录：' + e.message, keep, move, stop: [], notes } }

  const folders = []
  for (const e of names) {
    if (!e.isDirectory() || /^[_.]/.test(e.name)) continue
    const dir = join(root, e.name)
    const def = readDef(dir)
    if (!def) { move.push({ folder: e.name, dir, reason: '没有入口文件（index.mjs/js），加载不了，只会在面板留一个报错按钮' }); continue }
    const meta = readJson(dir) || {}
    folders.push({ folder: e.name, dir, id: String(meta.id || def.id || ''), mtime: Math.max(def.mtime, 0) })
  }

  // 按声明的 id 分组：文件夹名必须等于 id 才能被宿主加载
  const byId = new Map()
  for (const f of folders) {
    if (!byId.has(f.id)) byId.set(f.id, [])
    byId.get(f.id).push(f)
  }
  for (const [id, list] of byId) {
    if (list.length === 1) {
      const only = list[0]
      if (!ID_RE.test(id)) move.push({ folder: only.folder, dir: only.dir, reason: `模块 id「${id}」不合规，宿主不会加载` })
      else if (only.folder !== id) move.push({ folder: only.folder, dir: only.dir, reason: `文件夹名「${only.folder}」和模块 id「${id}」不一致，宿主不会加载（只会在面板留一个报错按钮）` })
      else keep.push({ folder: only.folder, id })
      continue
    }
    // 多份声明同一个 id：留 folder === id 的那份，没有就留最新的
    const canon = list.find((x) => x.folder === id) || [...list].sort((a, b) => b.mtime - a.mtime)[0]
    keep.push({ folder: canon.folder, id })
    for (const x of list) {
      if (x === canon) continue
      move.push({ folder: x.folder, dir: x.dir, reason: `和「${canon.folder}」重复声明 id「${id}」` })
    }
  }

  // 按钮清理：文件夹没了但还在跑的模块，要 stop 才会从面板消失
  let status = []
  try { status = api?.core?.modules?.status?.() || [] } catch {}
  const present = new Set(folders.map((f) => f.folder))
  const movingFolders = new Set(move.map((m) => m.folder))
  const stop = []
  for (const r of status) {
    if (!r || !r.running || r.builtin) continue
    const hasFolder = present.has(r.id) && !movingFolders.has(r.id)
    if (!hasFolder) stop.push({ id: r.id, reason: '文件夹已经不在 modules/ 里，但模块还在跑（面板按钮会留着）' })
  }
  // 被归档的那份如果正好在跑，也停掉
  for (const m of move) {
    const r = status.find((x) => x.id === m.folder)
    if (r && r.running && !stop.some((s) => s.id === m.folder)) stop.push({ id: m.folder, reason: '这个文件夹被归档了，但它还在跑' })
  }

  if (!move.length && !stop.length) notes.push('没有发现重复或残留的插件')
  return { ok: true, root, keep, move, stop, notes }
}

/** 真清理：归档重复文件夹 + 停掉残留模块。返回报告。 */
export function run(api, opts = {}) {
  const apply = opts.apply !== false
  const plan = scan(api)
  if (!plan.ok) return plan
  const stamp = new Date().toISOString().replace(/[-:T]/g, '').slice(0, 15)
  const trashRoot = join(plan.root, '..', 'modules-removed', 'auto-clean-' + stamp)
  const moved = []
  const failed = []
  if (apply) {
    for (const m of plan.move) {
      try {
        mkdirSync(trashRoot, { recursive: true })
        const to = join(trashRoot, m.folder)
        try { renameSync(m.dir, to) } catch { cpSync(m.dir, to, { recursive: true }); rmSync(m.dir, { recursive: true, force: true }) }
        moved.push({ folder: m.folder, to, reason: m.reason })
      } catch (e) { failed.push({ folder: m.folder, error: e.message }) }
    }
  }
  const stopped = []
  if (apply) {
    for (const s of plan.stop) {
      try {
        const r = api?.core?.modules?.stop?.(s.id)
        stopped.push({ id: s.id, reason: s.reason, result: r && r.ok === false ? String(r.message || '没停成') : 'stopped' })
      } catch (e) { stopped.push({ id: s.id, reason: s.reason, result: 'ERR ' + e.message }) }
    }
  }
  const report = {
    ok: true, apply, at: new Date().toISOString(),
    root: plan.root, trash: apply ? trashRoot : '',
    keep: plan.keep, move: apply ? moved : plan.move, stop: plan.stop,
    stopped, failed, notes: plan.notes,
  }
  if (apply) {
    try {
      const out = api.dataDir('cleanup')
      mkdirSync(out, { recursive: true })
      writeFileSync(join(out, 'last-report.json'), JSON.stringify(report, null, 2), 'utf8')
    } catch {}
  }
  return report
}

export const summaryLine = (r) => {
  if (!r || !r.ok) return '清理没跑成：' + (r?.message || '未知原因')
  if (r.apply === false) return `扫描结果：要归档 ${r.move.length} 个文件夹、停 ${r.stop.length} 个残留模块`
  return `已归档 ${(r.move || []).length} 个重复/无效文件夹到 modules-removed，停了 ${(r.stopped || []).length} 个残留模块；保留 ${(r.keep || []).length} 个`
}
