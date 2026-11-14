// 小游戏合集：她自己会玩 2048、贪吃蛇、扫雷，面板里能看她玩。
//
// - 定时自己挑一个玩（间隔可调），输赢会给她加减心情
// - 每走一步记一帧，面板可以实时看（也可以回放上一局）
// - 主人叫她玩：工具 mini_game_play 或 /游戏 [2048|蛇|扫雷]

import { readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

// ======================= 2048 =======================

const N = 4
const DIRS = ['up', 'down', 'left', 'right']

const empty2048 = () => Array.from({ length: N }, () => Array(N).fill(0))

function spawn2048(board) {
  const free = []
  for (let r = 0; r < N; r++) for (let c = 0; c < N; c++) if (!board[r][c]) free.push([r, c])
  if (!free.length) return false
  const [r, c] = free[Math.floor(Math.random() * free.length)]
  board[r][c] = Math.random() < 0.9 ? 2 : 4
  return true
}

function transforms(board, dir) {
  const grid = board.map((row) => [...row])
  const transpose = (g) => g[0].map((_, i) => g.map((row) => row[i]))
  const hflip = (g) => g.map((row) => [...row].reverse())
  if (dir === 'left') return { g: grid, back: (x) => x }
  if (dir === 'right') return { g: hflip(grid), back: hflip }
  if (dir === 'up') return { g: transpose(grid), back: transpose }
  const back = (g) => hflip(transpose(g))
  return { g: back(grid), back }
}

function move2048(board, dir) {
  const { g, back } = transforms(board, dir)
  let gained = 0
  let changed = false
  const next = g.map((row) => {
    const nums = row.filter((x) => x)
    const out = []
    for (let i = 0; i < nums.length; i++) {
      if (nums[i] === nums[i + 1]) { out.push(nums[i] * 2); gained += nums[i] * 2; i++ }
      else out.push(nums[i])
    }
    while (out.length < N) out.push(0)
    if (out.some((v, i) => v !== row[i])) changed = true
    return out
  })
  return changed ? { board: back(next), gained } : null
}

function score2048(b) {
  let empties = 0
  let smooth = 0
  const logs = b.map((row) => row.map((v) => (v ? Math.log2(v) : 0)))
  for (let r = 0; r < N; r++) {
    for (let c = 0; c < N; c++) {
      if (!b[r][c]) { empties++; continue }
      if (c + 1 < N && b[r][c + 1]) smooth -= Math.abs(logs[r][c] - logs[r][c + 1])
      if (r + 1 < N && b[r + 1][c]) smooth -= Math.abs(logs[r][c] - logs[r + 1][c])
    }
  }
  let bestMono = -Infinity
  const mono = (line) => {
    let inc = 0
    let dec = 0
    for (let i = 0; i + 1 < line.length; i++) {
      if (line[i] > line[i + 1]) dec += line[i + 1] - line[i]
      else inc += line[i] - line[i + 1]
    }
    return Math.max(inc, dec)
  }
  for (const rows of [logs, logs[0].map((_, i) => logs.map((r) => r[i]))]) {
    let sum = 0
    for (const line of rows) sum += mono(line)
    bestMono = Math.max(bestMono, sum)
  }
  const corner = Math.max(b[0][0], b[0][N - 1], b[N - 1][0], b[N - 1][N - 1])
  return empties * 270 + bestMono * 47 + smooth * 15 + Math.log2(corner || 1) * 12
}

function expectimax(board, depth, isPlayer) {
  if (depth === 0) return score2048(board)
  if (isPlayer) {
    let best = -Infinity
    for (const dir of DIRS) {
      const res = move2048(board, dir)
      if (res) best = Math.max(best, expectimax(res.board, depth, false))
    }
    return best === -Infinity ? score2048(board) : best
  }
  const free = []
  for (let r = 0; r < N; r++) for (let c = 0; c < N; c++) if (!board[r][c]) free.push([r, c])
  if (!free.length) return expectimax(board, depth - 1, true)
  let sum = 0
  for (const [r, c] of free) {
    for (const [v, p] of [[2, 0.9], [4, 0.1]]) {
      const next = board.map((row) => [...row])
      next[r][c] = v
      sum += p * expectimax(next, depth - 1, true)
    }
  }
  return sum / free.length
}

function bestMove2048(board) {
  let best = null
  for (const dir of DIRS) {
    const res = move2048(board, dir)
    if (!res) continue
    const score = expectimax(res.board, 2, false) + res.gained * 2 + Math.random() * 5
    if (!best || score > best.score) best = { score, board: res.board, gained: res.gained }
  }
  return best
}

function play2048(api, onFrame) {
  const board = empty2048()
  spawn2048(board)
  spawn2048(board)
  let score = 0
  for (let i = 0; i < 5000; i++) {
    const pick = bestMove2048(board)
    if (!pick) break
    for (let r = 0; r < N; r++) for (let c = 0; c < N; c++) board[r][c] = pick.board[r][c]
    score += pick.gained
    spawn2048(board)
    onFrame?.({ b: board.map((r) => [...r]), s: score })
  }
  const maxTile = Math.max(...board.flat())
  return { game: '2048', score, maxTile, won: maxTile >= 1024, detail: `${score} 分，最大块 ${maxTile}` }
}

// ======================= 贪吃蛇 =======================

const SNAKE_N = 12

function snakePath(from, to, blocked) {
  const key = (p) => p[0] * SNAKE_N + p[1]
  const prev = new Map()
  const seen = new Set([key(from)])
  const q = [from]
  while (q.length) {
    const cur = q.shift()
    if (cur[0] === to[0] && cur[1] === to[1]) {
      let step = cur
      while (prev.has(key(step)) && key(prev.get(key(step))) !== key(from)) step = prev.get(key(step))
      return step === from ? null : step
    }
    for (const [dr, dc] of [[-1, 0], [1, 0], [0, -1], [0, 1]]) {
      const nr = cur[0] + dr
      const nc = cur[1] + dc
      if (nr < 0 || nc < 0 || nr >= SNAKE_N || nc >= SNAKE_N) continue
      if (blocked.has(key([nr, nc])) || seen.has(key([nr, nc]))) continue
      seen.add(key([nr, nc]))
      prev.set(key([nr, nc]), cur)
      q.push([nr, nc])
    }
  }
  return null
}

function playSnake(api, onFrame) {
  const snake = [[6, 6], [6, 5], [6, 4]]
  let food = null
  const placeFood = () => {
    const taken = new Set(snake.map(([r, c]) => r * SNAKE_N + c))
    const free = []
    for (let r = 0; r < SNAKE_N; r++) for (let c = 0; c < SNAKE_N; c++) if (!taken.has(r * SNAKE_N + c)) free.push([r, c])
    food = free.length ? free[Math.floor(Math.random() * free.length)] : null
  }
  placeFood()
  const blocks = () => new Set(snake.slice(0, -1).map(([r, c]) => r * SNAKE_N + c))
  for (let step = 0; step < 900; step++) {
    const head = snake[0]
    let nextStep = food ? snakePath(head, food, blocks()) : null
    if (!nextStep) {
      const tail = snake[snake.length - 1]
      const options = [[-1, 0], [1, 0], [0, -1], [0, 1]]
        .map(([dr, dc]) => [head[0] + dr, head[1] + dc])
        .filter(([r, c]) => r >= 0 && c >= 0 && r < SNAKE_N && c < SNAKE_N && !blocks().has(r * SNAKE_N + c))
      nextStep = options.sort((a, b) => {
        const da = Math.abs(a[0] - tail[0]) + Math.abs(a[1] - tail[1])
        const db = Math.abs(b[0] - tail[0]) + Math.abs(b[1] - tail[1])
        return da - db
      })[0] || null
    }
    if (!nextStep) break
    snake.unshift(nextStep)
    if (food && nextStep[0] === food[0] && nextStep[1] === food[1]) placeFood()
    else snake.pop()
    onFrame?.({ snake: snake.map((p) => [...p]), food: food ? [...food] : null, s: Math.max(0, snake.length - 3) * 10 })
  }
  const score = Math.max(0, snake.length - 3) * 10
  return { game: 'snake', score, length: snake.length, won: score >= 150, detail: `蛇长 ${snake.length}，得 ${score} 分` }
}

// ======================= 扫雷 =======================

const MS_N = 9
const MS_MINES = 10

function playMinesweeper(api, onFrame) {
  const total = MS_N * MS_N
  const mine = new Set()
  while (mine.size < MS_MINES) mine.add(Math.floor(Math.random() * total))
  const num = (i) => {
    const r = Math.floor(i / MS_N)
    const c = i % MS_N
    let n = 0
    for (let dr = -1; dr <= 1; dr++) for (let dc = -1; dc <= 1; dc++) {
      const nr = r + dr
      const nc = c + dc
      if (nr < 0 || nc < 0 || nr >= MS_N || nc >= MS_N) continue
      if (mine.has(nr * MS_N + nc)) n++
    }
    return n
  }
  const revealed = new Set()
  const flagged = new Set()
  const neighbors = (i) => {
    const r = Math.floor(i / MS_N)
    const c = i % MS_N
    const out = []
    for (let dr = -1; dr <= 1; dr++) for (let dc = -1; dc <= 1; dc++) {
      if (!dr && !dc) continue
      const nr = r + dr
      const nc = c + dc
      if (nr < 0 || nc < 0 || nr >= MS_N || nc >= MS_N) continue
      out.push(nr * MS_N + nc)
    }
    return out
  }
  let dead = false
  const snap = () => onFrame?.({ rev: [...revealed].map((i) => [i, num(i)]), flags: [...flagged], dead })
  const open = (i) => {
    if (revealed.has(i) || flagged.has(i) || dead) return
    if (mine.has(i)) { dead = true; return }
    const stack = [i]
    while (stack.length) {
      const cur = stack.pop()
      if (revealed.has(cur) || flagged.has(cur) || mine.has(cur)) continue
      revealed.add(cur)
      if (num(cur) === 0) for (const nb of neighbors(cur)) if (!revealed.has(nb)) stack.push(nb)
    }
  }
  open(Math.floor(Math.random() * total))
  snap()
  for (let guard = 0; guard < 200 && !dead; guard++) {
    let acted = false
    for (const cell of [...revealed]) {
      const n = num(cell)
      if (!n) continue
      const un = neighbors(cell).filter((i) => !revealed.has(i))
      const fl = un.filter((i) => flagged.has(i))
      if (fl.length === n && un.length > fl.length) {
        for (const i of un) if (!flagged.has(i)) { open(i); acted = true }
      } else if (un.length - fl.length === n - fl.length && fl.length < n && un.length) {
        for (const i of un) if (!flagged.has(i)) { flagged.add(i); acted = true }
      }
      if (dead) break
    }
    if (!dead && !acted) {
      const unknown = []
      for (let i = 0; i < total; i++) if (!revealed.has(i) && !flagged.has(i)) unknown.push(i)
      if (!unknown.length) break
      const safe = unknown.filter((i) => !mine.has(i))
      const pick = (safe.length ? safe : unknown)[Math.floor(Math.random() * (safe.length || unknown.length))]
      open(pick)
    }
    snap()
    if (revealed.size >= total - MS_MINES) break
  }
  const won = !dead && revealed.size >= total - MS_MINES
  const score = revealed.size * 10
  return {
    game: 'minesweeper', score, revealed: revealed.size, won,
    detail: `${won ? '全清' : dead ? '踩雷' : '没扫完'}，开了 ${revealed.size} 格`,
  }
}

// ======================= 模块 =======================

const GAMES = {
  '2048': { title: '2048', play: play2048 },
  snake: { title: '贪吃蛇', play: playSnake },
  minesweeper: { title: '扫雷', play: playMinesweeper },
}

const LIVE = { id: '', title: '', frames: [], playing: false, result: null, at: 0 }
const MAX_FRAMES = 1500

export default {
  id: 'minigame',
  name: '小游戏合集',
  version: '1.0.0',
  api: 1,
  panel: 'panel.js',
  description: '她自己会玩 2048、贪吃蛇、扫雷：定时玩一局，输赢影响心情，面板里能看她下棋',
  defaults: { enabled: true, intervalMinutes: 30, maxKeep: 30 },
  settings: [
    { key: 'enabled', label: '让她自己玩', type: 'switch', hint: '关掉就不自动玩，只能你叫她玩' },
    { key: 'intervalMinutes', label: '多久玩一局（分钟）', type: 'number', min: 10, max: 720 },
    { key: 'maxKeep', label: '保留最近几局', type: 'number', min: 5, max: 100 },
  ],

  setup(api) {
    const file = () => join(api.dataDir(), 'stats.json')
    const load = () => { try { return JSON.parse(readFileSync(file(), 'utf8')) || {} } catch { return {} } }
    const save = (st) => { try { writeFileSync(file(), JSON.stringify(st, null, 1) + '\n', 'utf8') } catch (e) { api.log.warn?.(`[minigame] 存档失败：${e.message}`) } }

    const st = load()
    st.games ||= []
    st.byGame ||= {}
    st.total ||= 0
    st.wins ||= 0
    st.lastAt ||= 0
    st.last ||= null

    const moodOf = () => { try { return api.use('mood') } catch { return null } }

    function playOne(gameId) {
      const keys = Object.keys(GAMES)
      const id = GAMES[gameId] ? gameId : keys[Math.floor(Math.random() * keys.length)]
      LIVE.id = id
      LIVE.title = GAMES[id].title
      LIVE.frames = []
      LIVE.playing = true
      LIVE.result = null
      LIVE.at = Date.now()
      const onFrame = (frame) => { if (LIVE.frames.length < MAX_FRAMES) LIVE.frames.push(frame) }

      const result = GAMES[id].play(api, onFrame)
      LIVE.playing = false
      LIVE.result = result
      result.id = id
      result.title = GAMES[id].title
      result.at = LIVE.at

      st.total += 1
      st.lastAt = result.at
      st.last = result
      const rec = (st.byGame[id] ||= { plays: 0, wins: 0, best: 0 })
      rec.plays += 1
      if (result.won) { rec.wins += 1; st.wins += 1 }
      rec.best = Math.max(rec.best, result.score)
      st.games.push({ at: result.at, id, score: result.score, won: result.won })
      st.games = st.games.slice(-Math.max(5, Math.min(100, Number(api.settings().maxKeep) || 30)))
      save(st)

      let moodText = ''
      const mood = moodOf()
      if (mood?.nudge) {
        try {
          const d = result.won ? 3 : -2
          mood.nudge(d, `自己玩${result.title}${result.won ? '赢了' : '输了'}`)
          moodText = d > 0 ? '心情变好了' : '心情有点低落'
        } catch (error) { /* 心情模块可能没开 */ }
      }
      api.log.info(`[minigame] 玩了局${result.title}：${result.detail}（${result.won ? '赢' : '没赢'}）${moodText ? '，' + moodText : ''}`)
      api.emit('minigame/played', { ...result, moodText })
      return result
    }

    api.every(60_000, () => {
      const s = api.settings()
      if (!s.enabled) return
      const interval = Math.max(10, Number(s.intervalMinutes) || 30) * 60_000
      if (Date.now() - st.lastAt < interval) return
      playOne()
    }, '小游戏自动玩')

    api.tool(() => api.defineTool({
      name: 'mini_game_play',
      description: '自己玩一局小游戏（2048 / 贪吃蛇 / 扫雷），返回成绩。主人叫你玩游戏、或你自己想玩时用。',
      properties: { game: { type: 'string', description: '可选：2048 / snake / minesweeper，不填就随机' } },
      required: [],
      execute: async ({ game } = {}) => {
        const r = playOne(String(game || '').trim() || undefined)
        return { ok: true, message: `玩了局${r.title}：${r.detail}${r.won ? '，赢了！' : '，没赢…'}。我的${r.title}纪录是 ${(st.byGame[r.id] || {}).best || 0} 分。` }
      },
    }))

    api.context(() => {
      if (!st.last || Date.now() - st.lastAt > 2 * 60 * 60_000) return ''
      const mins = Math.max(1, Math.round((Date.now() - st.lastAt) / 60_000))
      return `【你刚才自己玩了局${st.last.title}】${st.last.detail}，${st.last.won ? '赢了' : '没赢'}；${mins} 分钟前。历史：一共玩了 ${st.total} 局，赢 ${st.wins} 局。想提就自然说一句，不想提就别提。`
    })

    api.command({
      name: '游戏',
      aliases: ['玩一局'],
      desc: '让她玩一局小游戏（可指定 2048 / 蛇 / 扫雷）',
      run: async (arg) => {
        const map = { 2048: '2048', 蛇: 'snake', 贪吃蛇: 'snake', 扫雷: 'minesweeper', 雷: 'minesweeper' }
        const id = map[String(arg || '').trim()] || undefined
        const r = playOne(id)
        return `${r.title}：${r.detail}${r.won ? '，赢了！' : '，没赢…'}\n一共玩了 ${st.total} 局，赢 ${st.wins} 局。`
      },
    })

    api.route('/state', async () => ({
      ok: true, total: st.total, wins: st.wins, byGame: st.byGame, last: st.last,
      games: st.games.slice(-10), intervalMinutes: api.settings().intervalMinutes, enabled: api.settings().enabled,
    }))
    api.route('/live', async () => ({
      ok: true, id: LIVE.id, title: LIVE.title, playing: LIVE.playing,
      frames: LIVE.frames, result: LIVE.result, at: LIVE.at,
      total: st.total, wins: st.wins, byGame: st.byGame,
      enabled: api.settings().enabled,
    }))
    // 总开关：面板上直接切（和设置页「让她自己玩」同一个值）
    api.route('/enabled', async (req) => {
      const b = await api.core.http.body(req)
      const on = !!b.on
      api.saveSettings({ enabled: on })
      api.log.info(`[minigame] 自动玩开关：${on ? '开' : '关'}`)
      return { ok: true, enabled: on }
    })
    api.route('/play', async (req) => {
      const q = new URL(req.url || '', 'http://x').searchParams.get('game') || ''
      const r = playOne(String(q).trim() || undefined)
      return { ok: true, ...r, stats: { total: st.total, wins: st.wins, byGame: st.byGame[r.id] } }
    })

    api.log.info(`[minigame] 小游戏合集就绪：已玩 ${st.total} 局（赢 ${st.wins}），共 ${Object.keys(GAMES).length} 个游戏`)
    return { play: playOne, stats: () => ({ total: st.total, wins: st.wins, byGame: st.byGame, last: st.last }) }
  },
}
