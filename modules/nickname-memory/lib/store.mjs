// 称呼本的存储和匹配：一个人可以有好几个叫法，最新的那个是他现在的称呼
import { existsSync, readFileSync, writeFileSync, renameSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'

export const MAX_NAME_LEN = 24
export const MAX_PEOPLE = 400
export const MAX_NAMES = 10
const FILE = 'nicknames.json'
const QQ_RE = /^\d{5,12}$/

export const isQQ = (text) => QQ_RE.test(String(text || '').trim())

// 控制字符、零宽字符、方向控制符：会让人看不出这名字里其实藏了东西
const NOISE_RE = /[\u0000-\u001f\u007f\u200b-\u200f\u202a-\u202e\u2060-\u2064\ufeff]/g
// 括号类会把名字和周围的字粘在一起，也容易在提示词里被当成结构
const BRACKET_RE = /[「」『』【】\[\]<>《》]/g

/**
 * 归一化：全角转半角、去掉看不见的字符和括号、压空格、限长。
 * 匹配、去重、写进系统提示词都用它。
 */
export function normalizeName(text) {
  let name = String(text ?? '')
    .normalize('NFKC')
    .replace(NOISE_RE, '')
    .replace(BRACKET_RE, '')
    .replace(/[\r\n\t]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
  if (name.length > MAX_NAME_LEN) name = name.slice(0, MAX_NAME_LEN)
  return name
}

const keyOf = (name) => normalizeName(name).toLowerCase()

export function emptyStore() {
  return { version: 1, people: {} }
}

function cleanEntry(qq, value) {
  const list = Array.isArray(value?.names) ? value.names : []
  const names = []
  const seen = new Set()
  for (const item of list) {
    const name = normalizeName(item?.name)
    if (!name) continue
    const key = keyOf(name)
    if (seen.has(key)) continue
    seen.add(key)
    names.push({
      name,
      at: Number(item?.at) || 0,
      source: String(item?.source || 'learn').slice(0, 8),
      by: String(item?.by || '').slice(0, 20),
      chatId: String(item?.chatId || '').slice(0, 40),
    })
  }
  if (!names.length) return null
  names.sort((a, b) => a.at - b.at)
  const current = normalizeName(value?.current) || names[names.length - 1].name
  return {
    qq,
    current: names.some((n) => keyOf(n.name) === keyOf(current)) ? current : names[names.length - 1].name,
    names: names.slice(-MAX_NAMES),
    firstSeen: Number(value?.firstSeen) || names[0].at || 0,
    updated: Number(value?.updated) || names[names.length - 1].at || 0,
  }
}

export function loadStore(dir) {
  const file = join(dir, FILE)
  try {
    if (!existsSync(file)) return emptyStore()
    const text = readFileSync(file, 'utf8')
    const raw = JSON.parse(text)
    const people = {}
    for (const [qq, value] of Object.entries(raw?.people || {})) {
      if (!QQ_RE.test(qq)) continue
      const entry = cleanEntry(qq, value)
      if (entry) people[qq] = entry
    }
    const store = { version: 1, people }
    // 老版本存过原话（evidence），现在不存了：读到就顺手洗掉，别让它留在盘上。
    if (/"evidence"\s*:/.test(text)) {
      try { saveStore(dir, store) } catch { /* 写不了就算了，下次再说 */ }
    }
    return store
  } catch {
    return emptyStore()
  }
}

export function saveStore(dir, store) {
  mkdirSync(dir, { recursive: true })
  const file = join(dir, FILE)
  const tmp = `${file}.${process.pid}.tmp`
  const body = { version: 1, people: store.people }
  writeFileSync(tmp, JSON.stringify(body, null, 2), 'utf8')
  renameSync(tmp, file)
}

function prune(store, maxPeople = MAX_PEOPLE) {
  const qqs = Object.keys(store.people)
  if (qqs.length <= maxPeople) return
  qqs.sort((a, b) => (store.people[a].updated || 0) - (store.people[b].updated || 0))
  for (const qq of qqs.slice(0, qqs.length - maxPeople)) delete store.people[qq]
}

/**
 * 记一个叫法。同一个人后来的叫法顶掉旧的（成为 current），旧叫法留着还能认出来。
 * 返回 { entry, previous, added, renamed }
 */
export function learnName(store, { qq, name, source = 'learn', by = '', chatId = '', now = Date.now(), maxNames = MAX_NAMES }) {
  const nick = normalizeName(name)
  if (!QQ_RE.test(String(qq || ''))) return { error: 'QQ 号不对' }
  if (!nick) return { error: '叫法是空的' }
  const person = store.people[qq] || { qq, current: '', names: [], firstSeen: now, updated: now }
  const previous = person.current || ''
  const key = keyOf(nick)
  const existing = person.names.find((item) => keyOf(item.name) === key)
  if (existing) {
    existing.at = now
    existing.by = String(by || '').slice(0, 20)
    existing.chatId = String(chatId || '').slice(0, 40)
    existing.source = String(source || 'learn').slice(0, 8)
    delete existing.evidence
  } else {
    person.names.push({
      name: nick,
      at: now,
      source: String(source || 'learn').slice(0, 8),
      by: String(by || '').slice(0, 20),
      chatId: String(chatId || '').slice(0, 40),
    })
  }
  person.names.sort((a, b) => a.at - b.at)
  if (person.names.length > maxNames) person.names = person.names.slice(-maxNames)
  person.current = nick
  person.updated = now
  store.people[qq] = person
  prune(store)
  return {
    entry: person,
    previous,
    added: !existing,
    renamed: Boolean(previous) && keyOf(previous) !== key,
  }
}

export function forgetName(store, qq, name) {
  const person = store.people[qq]
  if (!person) return false
  const key = keyOf(name)
  const left = person.names.filter((item) => keyOf(item.name) !== key)
  if (left.length === person.names.length) return false
  if (!left.length) {
    delete store.people[qq]
    return true
  }
  person.names = left
  if (keyOf(person.current) === key) person.current = left[left.length - 1].name
  person.updated = Date.now()
  return true
}

export function forgetPerson(store, qq) {
  if (!store.people[qq]) return false
  delete store.people[qq]
  return true
}

export function findByQQ(store, qq) {
  return store.people[String(qq || '').trim()] || null
}

/** 按叫法找人：先精确，再「包含」。返回 [{ person, matched, exact }] */
export function findByName(store, text) {
  const key = keyOf(text)
  if (!key) return []
  const exact = []
  const loose = []
  for (const person of Object.values(store.people)) {
    for (const item of person.names) {
      const itemKey = keyOf(item.name)
      if (itemKey === key) {
        exact.push({ person, matched: item.name, exact: true })
        break
      }
      if (!exact.length && (itemKey.includes(key) || key.includes(itemKey))) {
        loose.push({ person, matched: item.name, exact: false })
        break
      }
    }
  }
  return exact.length ? exact : loose
}

export function listPeople(store) {
  return Object.values(store.people).sort((a, b) => (b.updated || 0) - (a.updated || 0))
}

/** 在某个聊天里学到的叫法（用来在群里提示「你记着这些人」） */
export function namesOfChat(store, chatId, limit = 10) {
  const rows = []
  for (const person of Object.values(store.people)) {
    const hit = [...person.names].reverse().find((item) => item.chatId === chatId)
    if (hit) rows.push({ qq: person.qq, name: hit.name, current: person.current, at: hit.at })
  }
  rows.sort((a, b) => (b.at || 0) - (a.at || 0))
  return rows.slice(0, limit)
}

/** 别名列表（去掉现在的称呼），给「也叫过……」用 */
export function otherNames(person) {
  const key = keyOf(person.current)
  return person.names.map((item) => item.name).filter((name) => keyOf(name) !== key)
}
