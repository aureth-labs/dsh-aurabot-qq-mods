import { createHash } from 'node:crypto'

export const LIFE_SLEEP = Symbol.for('aurabot.character-life.sleep.v1')
const MEMORY = Symbol.for('aurabot.persona-memory.owner.v1')
const MAX_WAITING = 80
const MAX_EVENT_BYTES = 64 * 1024

export function createSleepInbox(api, life) {
  const resumes = new WeakSet()
  let stopped = false
  let draining = false
  const memory = () => globalThis[MEMORY]
  const ready = () => !stopped && typeof api.core.hub.resumeCharacterSleep === 'function' && !!memory()?.managed?.()
  const viewing = () => life.view(life.current())
  const sleeping = v => v.config.sleepReply === 'after-wake' && !!v.activeSleepId
  const canWork = () => ready() && api.config().enabled && !api.config().dryRun

  function current(entry, view = viewing()) {
    if (!canWork() || !view.available || view.card.revision !== entry.cardRevision || view.epoch !== entry.epoch
      || life.owner() !== entry.owner || view.personaId !== entry.personaId) return false
    try { memory().assert(entry.capture); return true } catch { return false }
  }

  function hold({ event, chatId, messageId, at }) {
    if (!canWork() || !messageId || messageId === '0') return false
    life.observeConversation?.()
    const view = viewing()
    if (!view.available) return false
    const owner = life.owner(), id = view.personaId
    const bucket = life.runtime.read(owner, id).sleep
    const inbox = bucket?.inbox || []
    const key = chatId + ':' + messageId
    if (inbox.some(entry => entry.key === key)) return true
    if (!sleeping(view) && !inbox.some(entry => entry.chatId === chatId && ['waiting','dispatching'].includes(entry.status))) return false
    const capture = memory().capture(chatId)
    if (!capture || capture.input?.persona !== id) return false
    memory().assert(capture)
    if (inbox.filter(entry => ['waiting', 'dispatching', 'unknown'].includes(entry.status)).length >= MAX_WAITING
      || Buffer.byteLength(JSON.stringify(event)) > MAX_EVENT_BYTES) return false

    const window = Math.floor(at / (5 * 60000))
    const roll = createHash('sha256').update(JSON.stringify([owner, id, view.activeSleepId, window])).digest().readUInt32BE() / 0x100000000
    const wakes = sleeping(view) && roll * 100 < view.config.sleepWakeChance
    life.runtime.change(owner, id, row => {
      row.sleep ||= { inbox: [] }
      const active = row.sleep.inbox.filter(entry => !['handled','cancelled'].includes(entry.status))
      const recent = row.sleep.inbox.filter(entry => ['handled','cancelled'].includes(entry.status)).slice(-MAX_WAITING)
      row.sleep.inbox = [...recent, ...active, { key, chatId, event, at, owner, personaId:id,
        cardRevision:view.card.revision, capture, epoch:view.epoch, status:'waiting' }]
      if (wakes) row.sleep.awake = { id:view.activeSleepId, at }
    })
    return true
  }

  function permits(entry, chatId) {
    return resumes.has(entry) && entry.chatId === chatId && current(entry)
  }

  async function tick() {
    if (!canWork() || draining) return
    const owner = life.owner(), id = life.current()
    const batch = life.runtime.read(owner,id).sleep?.inbox.filter(entry => entry.status === 'waiting').slice(0,12) || []
    if (!batch.length) return
    const view = viewing()
    if (!view.available || sleeping(view)) return
    draining = true
    try {
      for (const entry of batch) {
        if (stopped || life.owner() !== owner || life.current() !== id || sleeping(viewing())) break
        function settle(status) {
          life.runtime.change(owner,id,row => {
            const saved = row.sleep.inbox.find(item => item.key === entry.key)
            if (!saved || !['waiting','dispatching'].includes(saved.status)) return
            saved.status = status
            if (status === 'handled' || status === 'cancelled') { delete saved.event; delete saved.capture }
          })
        }
        if (!current(entry)) { settle('cancelled'); continue }
        settle('dispatching')
        resumes.add(entry)
        let status = 'handled'
        try { await api.core.hub.resumeCharacterSleep(entry) }
        catch { status = 'unknown' }
        finally { resumes.delete(entry) }
        if (stopped) break
        settle(status)
      }
    } finally { draining = false }
  }

  return { hold, permits, tick, ready, quiet:() => canWork() && sleeping(viewing()), stop:() => { stopped = true } }
}
