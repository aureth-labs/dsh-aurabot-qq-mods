import { createHash, randomUUID } from 'node:crypto'
import { readFileSync, renameSync, writeFileSync } from 'node:fs'

export function imageKeys(key, md5, bytes) {
  return [
    key,
    typeof md5 === 'string' && /^[a-f0-9]{32}$/i.test(md5) && 'md5:' + md5.toLowerCase(),
    bytes && 'sha256:' + createHash('sha256').update(bytes).digest('hex'),
  ].filter(Boolean)
}

function readJson(file) {
  try { return JSON.parse(readFileSync(file, 'utf8')) }
  catch (error) { if (error.code !== 'ENOENT') throw error; return null }
}

export function openImageDelivery(file, legacyFiles) {
  function write(history) {
    const temporary = file + '.tmp-' + process.pid
    writeFileSync(temporary, JSON.stringify(history), { mode: 0o600 })
    renameSync(temporary, file)
  }
  if (!readJson(file)) {
    const history = {}
    for (const legacy of legacyFiles) {
      for (const slot of Object.values(readJson(legacy)?.slots ?? {})) {
        for (const [chatId, status] of Object.entries(slot.recipients ?? {})) {
          if (!/^(?:group|private):\d+$/.test(chatId) || !['sent', 'sending', 'uncertain'].includes(status)) continue
          const records = history[chatId] ??= {}
          for (const { key, md5 } of slot.images ?? []) {
            for (const identity of imageKeys(key, md5)) records[identity] = 'legacy'
          }
        }
      }
    }
    write(history)
  }
  const read = () => readJson(file) ?? {}
  return {
    known(...chatIds) {
      const history = read()
      return new Set(chatIds.flatMap(chatId => Object.keys(history[chatId] ?? {})))
    },
    reserve(chatId, images) {
      const history = read()
      const records = history[chatId] ??= {}
      const claim = randomUUID()
      const items = []
      const reserved = []
      for (const image of images) {
        if (image.keys.some(key => Object.hasOwn(records, key))) continue
        items.push(image)
        for (const key of image.keys) { records[key] = claim; reserved.push(key) }
      }
      if (reserved.length) write(history)
      return {
        items,
        release() {
          if (!reserved.length) return
          const current = read()
          const records = current[chatId] ?? {}
          for (const key of reserved) if (records[key] === claim) delete records[key]
          write(current)
        },
      }
    },
  }
}
