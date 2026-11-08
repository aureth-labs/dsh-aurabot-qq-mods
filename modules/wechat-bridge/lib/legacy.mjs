import { createHash } from 'node:crypto'
import { readFile, stat } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { gatewaySettings, privateId } from './gateway.mjs'

async function readJson(file, maxBytes) {
  const info = await stat(file)
  if (!info.isFile() || info.size > maxBytes) throw new Error('旧合并版数据文件超出读取范围')
  return JSON.parse((await readFile(file, 'utf8')).replace(/^\uFEFF/, ''))
}

export async function legacyLink(ids) {
  const root = process.env.AURABOT_UNIFIED_DATA_DIR ||
    join(process.env.DSH_HOME || join(homedir(), '.dsh'), 'plugins-data', 'aurabot-unified')
  let state
  try { state = await readJson(join(root, 'settings.json'), 1024 * 1024) } catch {
    throw new Error('读不到旧合并版的设置')
  }
  const qq = state?.channels?.qq
  const wechat = state?.channels?.wechat
  const owner = privateId(wechat?.ownerQQ)
  const bot = privateId(wechat?.botQQ)
  const config = wechat?.wechat && gatewaySettings(wechat.wechat)
  if (!qq?.setupDone || !wechat?.setupDone || String(qq.ownerQQ) !== ids.qq || String(qq.botQQ) !== ids.qqBot ||
    state.ownerLink?.qq !== ids.qq || state.ownerLink?.wechat !== owner || !owner || !bot || owner === bot || !config) {
    throw new Error('旧合并版的主人关联或机器人身份与当前 QQ 配置不一致')
  }
  const bank = createHash('sha256').update(JSON.stringify([ids.qq, owner])).digest('hex').slice(0, 32)
  return { binding: { ...ids, config, owner, bot }, root, bank }
}

export async function legacyFacts({ root, bank }) {
  let data
  try { data = await readJson(join(root, 'shared-memory', bank + '.json'), 8 * 1024 * 1024) } catch {
    throw new Error('读不到旧合并版的共享记忆库')
  }
  if (!Array.isArray(data?.items)) throw new Error('旧合并版的共享记忆格式无效')
  const now = Date.now()
  return data.items.filter((row) => row && ['qq', 'wechat'].includes(row.origin) && row.scope !== 'group' &&
    row.kind !== 'seen' && ['fact', '', undefined].includes(row.status) && !row.invalidAt &&
    (!row.about || row.about === 'owner') && (!row.speaker || row.speaker === 'owner') &&
    (!row.validFrom || Number(row.validFrom) <= now) && (!row.validUntil || Number(row.validUntil) > now) &&
    typeof row.text === 'string' && row.text.trim())
}
