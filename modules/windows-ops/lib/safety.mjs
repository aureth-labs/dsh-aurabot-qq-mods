// safety.mjs —— windows-ops 模块安全闸门
// 来源：aurabot 模块库 modules/windows-ops（本仓库原创，MIT；闸门思路对齐 modules/phone/lib/safety.mjs）
// 作用：操作白名单 + 键鼠模拟开关 + 危险操作确认队列 + 滑动窗口限速 + 操作日志。
//       全部状态在内存（模块停下即清零），日志落 api.dataDir()/logs/。
// 契约：export function createSafety({ dataDir, getSettings, opsMeta, windowMs? })
//   getSettings()（每次现读）：{ opsWhitelist: string[], allowInput: boolean,
//     confirmDanger: boolean, dryRun: boolean, rateLimit: number }
//   opsMeta：{ <op>: { label, danger: 'safe'|'input'|'close' } }（来自 lib/ops.mjs 的 OPS）
//   → { checkOp(op) → {ok, reason?}, checkRate() → boolean,
//       gate({op, summary}) → {verdict:'ALLOW'|'REJECT'|'DRY_RUN'|'NEED_CONFIRM', id?, reason?},
//       listConfirms() → [{id, op, summary, at}], approveConfirm(id) → boolean,
//       rejectConfirm(id) → boolean, log(action, detail) → Promise }
// 判定顺序：REJECT（白名单/开关/未知操作）→ DRY_RUN → NEED_CONFIRM（危险 && confirmDanger）→ ALLOW。
// 「确认」是一次性的：批准后放行一次同 op+summary 的动作即消耗，10 分钟内有效。
import { mkdirSync, appendFileSync } from 'node:fs'
import { join } from 'node:path'
import { createHash } from 'node:crypto'

const CONFIRM_TTL_MS = 10 * 60_000 // 待确认项 10 分钟没批就作废
const APPROVED_TTL_MS = 10 * 60_000 // 批准后一次性放行，同样 10 分钟内有效

/** 本地日期 YYYY-MM-DD（日志按天分文件）。 */
function localDate(d = new Date()) {
  const p = (n) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`
}

/** op + 参数摘要 → 确认指纹（同 op 同参数才算同一个动作）。 */
function fingerprint(op, summary) {
  return createHash('md5').update(`${op}\n${String(summary || '')}`).digest('hex')
}

export function createSafety({ dataDir, getSettings, opsMeta = {}, windowMs = 60000 } = {}) {
  const pending = new Map() // id → { id, op, summary, fp, at } 待确认
  const approved = new Map() // fp → at 已批准（一次性）
  const rateStamps = [] // 限速滑动窗口

  /** 操作白名单 / 开关校验：whitelist 空 = 用内置白名单（全部非危险操作 + 已开启的输入操作）。 */
  function checkOp(op) {
    const s = getSettings() || {}
    const meta = opsMeta[String(op)]
    if (!meta) return { ok: false, reason: `未知操作：${String(op).slice(0, 40)}（可用操作看 /wops ops）` }
    const wl = (s.opsWhitelist || []).map((x) => String(x).trim()).filter(Boolean)
    if (wl.length && !wl.includes(String(op))) return { ok: false, reason: `操作 ${op} 不在白名单（面板「操作白名单」里加一行）` }
    if (meta.danger === 'input' && !s.allowInput) return { ok: false, reason: `键鼠模拟没开：面板打开「允许键鼠模拟」才能用 ${op}` }
    return { ok: true }
  }

  /** 限速：窗口内超过 rateLimit 次就拒（rateLimit<=0 = 不限）。 */
  function checkRate() {
    const s = getSettings() || {}
    const limit = Number(s.rateLimit) || 0
    const now = Date.now()
    while (rateStamps.length && now - rateStamps[0] >= windowMs) rateStamps.shift()
    if (limit > 0 && rateStamps.length >= limit) return false
    rateStamps.push(now)
    return true
  }

  /** 综合闸门。summary 是给主人看的参数摘要（确认队列里显示它）。 */
  function gate({ op, summary = '' } = {}) {
    const cp = checkOp(String(op))
    if (!cp.ok) return { verdict: 'REJECT', reason: cp.reason }
    const s = getSettings() || {}
    if (s.dryRun) return { verdict: 'DRY_RUN' }
    const meta = opsMeta[String(op)]
    if (meta.danger !== 'safe' && s.confirmDanger !== false) {
      const fp = fingerprint(op, summary)
      // 已批准的一次性放行：命中即消耗
      if (approved.has(fp) && Date.now() - approved.get(fp) <= APPROVED_TTL_MS) {
        approved.delete(fp)
        return { verdict: 'ALLOW' }
      }
      approved.delete(fp)
      // 同 op+summary 已有待确认项就不重复建（10 分钟 TTL）
      for (const item of pending.values()) {
        if (item.fp === fp && Date.now() - item.at <= CONFIRM_TTL_MS) return { verdict: 'NEED_CONFIRM', id: item.id }
      }
      const id = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
      const item = { id, op: String(op), summary: String(summary).slice(0, 160), fp, at: Date.now() }
      pending.set(id, item)
      return { verdict: 'NEED_CONFIRM', id }
    }
    return { verdict: 'ALLOW' }
  }

  /** 待确认列表（过期项顺手清掉）。 */
  function listConfirms() {
    const now = Date.now()
    for (const [id, item] of pending) if (now - item.at > CONFIRM_TTL_MS) pending.delete(id)
    return [...pending.values()].map(({ id, op, summary, at }) => ({ id, op, summary, at }))
  }

  /** 批准：从待确认移除并记一次性放行。id 只能是本函数发出去的（Map 键天然校验）。 */
  function approveConfirm(id) {
    const item = pending.get(String(id))
    if (!item) return false
    pending.delete(String(id))
    approved.set(item.fp, Date.now())
    return true
  }

  /** 拒绝：只从待确认移除。 */
  function rejectConfirm(id) {
    return pending.delete(String(id))
  }

  /** 操作日志：按天追加 dataDir/logs/ops-YYYY-MM-DD.log。 */
  async function log(action, detail = '') {
    try {
      mkdirSync(join(dataDir, 'logs'), { recursive: true })
      const line = `${new Date().toISOString()}\t${action}\t${String(detail).replace(/\r?\n/g, ' ').slice(0, 300)}\n`
      appendFileSync(join(dataDir, 'logs', `ops-${localDate()}.log`), line)
    } catch { /* 日志失败不影响动作本身 */ }
  }

  return { checkOp, checkRate, gate, listConfirms, approveConfirm, rejectConfirm, log }
}
