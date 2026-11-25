import { createHash } from 'node:crypto'
import { setTimeout as delay } from 'node:timers/promises'

export function isSendTimeout(error) {
  return /超时|timeout|timed?\s*out/i.test(error?.message ?? '')
}

export function definitelyFailed(error) {
  return !error.uncertain && !isSendTimeout(error) && !/EventChecker Failed/i.test(error.message) &&
    (error.transport || error.data?.status === 'failed' || Number(error.data?.retcode || 0) !== 0)
}

export function isRiskControlRejection(error) {
  if (error?.uncertain || isSendTimeout(error)) return false
  const details = [error?.data?.message, error?.data?.wording, error?.message]
  return details.some(text => typeof text === 'string' &&
    /风控|風控|risk[\s_-]+control/i.test(text) &&
    !/(?:疑似|可能|未触发|未觸發|not\s+(?:blocked|rejected)|suspected|possibly)/i.test(text))
}

function imageHash(segment) {
  const file = String(segment.data?.file ?? '')
  if (file.startsWith('base64://')) {
    return createHash('md5').update(Buffer.from(file.slice(9), 'base64')).digest('hex')
  }
  // NapCat returns the original image MD5 as the history image filename.
  const hash = segment.data?.md5 || /^[a-f0-9]{32}(?=\.|$)/i.exec(file)?.[0]
  return /^[a-f0-9]{32}$/i.test(hash ?? '') ? hash.toLowerCase() : ''
}

export async function confirmGroupImages(api, chatId, segments, startedAt, signal) {
  const group = /^group:(\d+)$/.exec(chatId)
  const botQQ = String(api.config().botQQ ?? '')
  if (!group || !botQQ || typeof api.onebot !== 'function' || signal?.aborted) return null
  const expected = segments.filter(segment => segment.type === 'image').map(imageHash).sort()
  if (!expected.length || expected.some(hash => !hash)) return null
  const earliest = Math.floor(startedAt / 1000)
  for (const wait of [0, 1000]) {
    try {
      if (wait) await delay(wait, undefined, { signal })
      if (signal?.aborted || String(api.config().botQQ) !== botQQ) return null
      const result = await api.onebot('get_group_msg_history', { group_id: Number(group[1]), count: 50 }, { timeoutMs: 3500 })
      if (signal?.aborted || String(api.config().botQQ) !== botQQ) return null
      const history = Array.isArray(result) ? result : result?.messages
      if (!Array.isArray(history)) continue
      const match = history.find(message => {
        if (String(message.user_id ?? message.sender?.user_id) !== botQQ ||
            (message.group_id != null && String(message.group_id) !== group[1]) ||
            message.message_id == null || !Number.isFinite(Number(message.time)) ||
            Number(message.time) < earliest || !Array.isArray(message.message)) return false
        const hashes = message.message.filter(segment => segment.type === 'image').map(imageHash).sort()
        return hashes.length === expected.length && hashes.every((hash, index) => hash === expected[index])
      })
      if (match) return { message_id: match.message_id }
    } catch {
      if (signal?.aborted) return null
    }
  }
  return null
}
