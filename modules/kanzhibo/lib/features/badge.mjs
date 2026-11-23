// features/badge.mjs —— 灯牌：判据骨架 + 状态机（attempted/sent/asked/gaveup）
// 注意：badgeRowState 的具体“已送/可送”判别必须用 M0 的 4 态 fixture 定稿后再实锤；
//       这里实现的是**保守骨架**（verified=false），M2 阶段只做状态机与迁移，判据待 fixture。
import { roomKeyOf } from '../util.mjs'


const STRONG_SENT = /已完成|已领取|已点亮|今日已送/
const WEAK_SENT = /今日第\d+位送灯牌|连续\d+天/
const OPEN_TEXT = /1钻，可得100亲密度/
// 只认“可点按钮”文案；注意「送1个基础灯牌」在已送态的行文案里也出现，不能当 open 判据（fixture 定稿前先不列）
const OPEN_BTN = /送灯牌|赠送|点亮|立即续费/

/** 找“灯牌那一行”（保守：文本里含 灯牌 的那一行；fixture 定稿后再按 AX 行容器）。 */
function badgeRow(text) {
  const lines = String(text || '').split(/\r?\n/)
  const hit = lines.filter((l) => /灯牌|勋章|点亮粉丝团/.test(l))
  return hit.join('\n')
}

/**
 * 判据（保守骨架，verified=false）：
 *  - sent: 灯牌行出现强完成标记；或弱标记(今日第N位/连续N天)且 progressBefore>=1
 *  - open: 含“1钻，可得100亲密度” 或 可点按钮文案，且无完成标记
 *  - unknown: 其余
 * 返回 { state, kind, reason, verified }
 */
export function badgeRowState(text, { progressBefore = null } = {}) {
  const row = badgeRow(text)
  if (!row) return { state: 'unknown', kind: '未知', reason: '没有灯牌行', verified: false }
  const strong = STRONG_SENT.test(row)
  const weak = WEAK_SENT.test(row)
  const lines = String(text || '').split(/\r?\n/).map((x) => x.trim())
  const btnLine = lines.find((l) => /^(送灯牌|赠送|点亮|立即续费)$/.test(l) || /^点亮\s*[（(][^）)]{0,8}[)）]$/.test(l))
  const open = OPEN_TEXT.test(text) || Boolean(btnLine) || /点亮粉丝团恢复勋章|勋章已熄灭/.test(text)
  if (strong) return { state: 'sent', kind: '已送', reason: '完成标记', verified: false }
  if (weak && progressBefore !== null && Number(progressBefore) >= 1) {
    return { state: 'sent', kind: '已送', reason: '弱标记且进度≥1', verified: false }
  }
  if (open) {
    const kind = /点亮粉丝团恢复勋章|勋章已熄灭|恢复点亮/.test(row) ? '恢复' : '可送(续费)'
    return { state: 'open', kind, reason: '有可点按钮/可得100', verified: false }
  }
  if (/加入粉丝团/.test(row)) return { state: 'unknown', kind: '未加入', reason: '仅加入粉丝团', verified: false }
  return { state: 'unknown', kind: '未知', reason: weak ? '弱标记但进度未知' : '无法判定', verified: false }
}

/** 状态机：只有 idle / 过了 askedDay 才允许自动尝试；sent/attempted/gaveup/asked 都不自动。 */
