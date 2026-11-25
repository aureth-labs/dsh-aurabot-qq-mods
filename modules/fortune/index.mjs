// 今日运势：发「运势」抽一签，每人每天一签。
// 数据存 modules-data/fortune/draws.json，按 chatId + userId 记当天抽到的签。

import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs'
import { join } from 'node:path'

const WORDS = ['大吉', '中吉', '小吉', '末吉']

// 每种签配几句，抽的时候随机一句，别每次都说同一句
const TIPS = {
  大吉: [
    '今天诸事顺遂，想做什么就去做吧',
    '该出手时就出手，今天手气好得很',
    '万事顺心，连排队都会比平时快',
  ],
  中吉: [
    '平平稳稳的一天，不折腾就是赢',
    '有点小惊喜，别错过路上的细节',
    '按原计划走，结果比你想的好一点',
  ],
  小吉: [
    '小有收获，适合把拖着的小事做掉',
    '别贪多，挑一件做完就够',
    '今天适合整理，不适合开新坑',
  ],
  末吉: [
    '慢一点，别急着下结论',
    '今天宜守不宜攻，稳住就好',
    '遇到不顺心的，先放一放再说',
  ],
}

const TRIGGERS = new Set(['运势', '抽签', '今日运势', '求签'])

// 测试钩子：把内部函数挂出来，模拟测试能直接调
export const hooks = {}

function today() {
  // 用本地时区的 YYYY-MM-DD，跨天就重置
  const d = new Date()
  const p = (n) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`
}

function readDb(dir) {
  const p = join(dir, 'draws.json')
  try {
    if (!existsSync(p)) return {}
    const obj = JSON.parse(readFileSync(p, 'utf8'))
    return obj && typeof obj === 'object' && !Array.isArray(obj) ? obj : {}
  } catch {
    return {}
  }
}

function writeDb(dir, db) {
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, 'draws.json'), JSON.stringify(db, null, 2), 'utf8')
}

function pick(arr) {
  return arr[Math.floor(Math.random() * arr.length)]
}

function draw() {
  const word = pick(WORDS)
  return { word, tip: pick(TIPS[word]) }
}

function render(word, tip, isOwner, again) {
  const head = isOwner ? `抽到了「${word}」～` : `今日签：${word}`
  const tail = again ? '（今天已经抽过啦，就这一签）' : tip
  return `${head}\n${tail}`
}

// 模块加载时就挂好，测试不用等 setup
hooks.draw = draw
hooks.render = render
hooks.today = today

export default {
  id: 'fortune',
  name: '今日运势',
  version: '1.0.0',
  api: 1,
  description: '发「运势」抽一签，每人每天一签',

  setup(api) {
    const dir = api.dataDir()
    let db = readDb(dir)

    // 让 她 知道这个模块存在，但不强制她自己去用
    api.rule(() => '有人发「运势」「抽签」「今日运势」「求签」时，模块会自己回一签并接管这条消息，你不用再回答。')

    api.on('message', async (msg) => {
      const text = String(msg.text || '').trim()
      if (!TRIGGERS.has(text)) return false

      const day = today()
      const key = `${msg.chatId}|${msg.userId}`
      const rec = db[key]

      // 同一个 chat + 同一个用户，同一天只给一签
      if (rec && rec.day === day) {
        await api.reply(msg, render(rec.word, rec.tip, api.isOwner(msg.userId), true))
        return true
      }

      const { word, tip } = draw()
      db[key] = { day, word, tip, at: Date.now() }

      // 顺手清掉上周的旧记录，别让文件无限长
      const cutoff = Date.now() - 7 * 24 * 3600 * 1000
      for (const [k, v] of Object.entries(db)) {
        if (!v || typeof v.at !== 'number' || v.at < cutoff) delete db[k]
      }

      writeDb(dir, db)
      api.log.debug(`fortune: ${key} -> ${word}`)

      await api.reply(msg, render(word, tip, api.isOwner(msg.userId), false))
      return true
    })
  },
}
