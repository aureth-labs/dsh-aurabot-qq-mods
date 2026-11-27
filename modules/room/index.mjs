/**
 * 小鱼小屋 —— 她自己的房间
 * 攒鱼币 → 买家具 → 随便摆。聊天里能买，面板里能拖。
 */
import { readFileSync, writeFileSync, existsSync } from 'node:fs'
import { join } from 'node:path'

const CATALOG = [
  { kind: 'rug',    name: '地毯',        price: 40,  hint: '铺在地上的那块' },
  { kind: 'desk',   name: '木桌',        price: 80,  hint: '带抽屉，桌上总有杯凉掉的牛奶' },
  { kind: 'sofa',   name: '深蓝沙发椅',  price: 120, hint: '她最爱窝的地方' },
  { kind: 'bed',    name: '床',          price: 150, hint: '深蓝毯子，枕头有点塌' },
  { kind: 'lamp',   name: '鲸鱼台灯',    price: 90,  hint: '尾巴当灯臂，灯泡有点旧了' },
  { kind: 'snacks', name: '一箱零食',    price: 30,  hint: '薯片、饼干、棒棒糖' },
  { kind: 'frame',  name: '小鱼画',      price: 20,  hint: '墙上那幅', mount: 'wall' },
  { kind: 'plant',  name: '盆栽',        price: 25,  hint: '窗台边的绿' },
  // —— 后来添的 ——
  { kind: 'shelf',   name: '书架',       price: 110, hint: '三格，塞满了没看完的书' },
  { kind: 'fishtank',name: '小鱼缸',     price: 95,  hint: '缸里养了一条橙色的小鱼' },
  { kind: 'mirror',  name: '落地镜',     price: 70,  hint: '出门前总要照一下' },
  { kind: 'cushion', name: '抱枕堆',     price: 20,  hint: '三个，颜色都不一样' },
  { kind: 'clock',   name: '挂钟',       price: 40,  hint: '走得不太准', mount: 'wall' },
  { kind: 'lights',  name: '星星串灯',   price: 45,  hint: '挂了就不想关', mount: 'wall' },
  { kind: 'tv',      name: '电视',       price: 160, hint: '挂墙的，屏幕里老是那条鱼', mount: 'wall' },
  { kind: 'pc',      name: '电脑',       price: 200, hint: '显示器、主机、键盘，一整套' },
  { kind: 'cooker',  name: '电饭煲',     price: 60,  hint: '一直保温着，随时有热饭' },
  { kind: 'washer',  name: '洗衣机',     price: 170, hint: '滚筒的，转起来嗡嗡响' },
]

const FISH = { kind: 'fish', name: '小鱼', x: 45, y: 88 }

const DAY = () => new Date(Date.now() + 8 * 3600e3).toISOString().slice(0, 10)

export default {
  id: 'room',
  name: '小鱼小屋',
  version: '1.2.0',
  api: 1,
  description: '属于她自己的房间：聊一句攒一点，攒够了买家具和装饰，面板里随便拖',
  defaults: { coinName: '鱼币', startCoins: 420, earnPerMessage: 1, earnPerDay: 60 },
  settings: [
    { key: 'coinName', label: '货币名字', type: 'text', hint: '默认「鱼币」' },
    { key: 'startCoins', label: '初始余额', type: 'number', min: 0, max: 99999, step: 10 },
    { key: 'earnPerMessage', label: '每聊一句加多少', type: 'number', min: 0, max: 20, step: 1 },
    { key: 'earnPerDay', label: '每天最多挣多少', type: 'number', min: 0, max: 999, step: 10 },
  ],
  panel: 'panel.js',

  setup(api) {
    const file = () => join(api.dataDir(), 'room.json')

    const settings = () => {
      const s = api.settings() || {}
      return {
        coinName: (s.coinName || '鱼币').trim() || '鱼币',
        startCoins: Number(s.startCoins ?? 320),
        earnPerMessage: Number(s.earnPerMessage ?? 1),
        earnPerDay: Number(s.earnPerDay ?? 60),
      }
    }

    function load() {
      const f = file()
      let d = {}
      if (existsSync(f)) {
        try { d = JSON.parse(readFileSync(f, 'utf8')) } catch { d = {} }
      }
      const st = settings()
      if (typeof d.coins !== 'number') d.coins = Math.max(0, st.startCoins)
      if (!Array.isArray(d.items)) d.items = []
      if (!d.earn || typeof d.earn !== 'object') d.earn = { day: DAY(), got: 0 }
      if (d.earn.day !== DAY()) d.earn = { day: DAY(), got: 0 }
      // 清掉目录里已经没有的物品（小鱼除外，她一直住这儿）
      d.items = d.items.filter((i) => i && (i.kind === FISH.kind || CATALOG.some((c) => c.kind === i.kind)))
      if (!d.items.some((i) => i.kind === FISH.kind)) {
        d.items.push({ kind: FISH.kind, x: FISH.x, y: FISH.y, at: Date.now(), fixed: true })
      }
      return d
    }

    function save(d) {
      writeFileSync(file(), JSON.stringify(d, null, 2), 'utf8')
      return d
    }

    const meta = (kind) => CATALOG.find((c) => c.kind === kind)
    const has = (d, kind) => d.items.some((i) => i.kind === kind)
    const find = (d, kind) => d.items.find((i) => i.kind === kind)

    // 按名字找物品：先精确、再去掉空格、再模糊
    function pick(word) {
      const w = String(word || '').trim()
      if (!w) return null
      const exact = CATALOG.find((c) => c.name === w || c.kind === w)
      if (exact) return exact
      return CATALOG.find((c) => c.name.includes(w) || w.includes(c.name)) || null
    }

    // 空位：沿地毯从左到右排开
    function freeSpot(d, kind) {
      const slot = CATALOG.findIndex((c) => c.kind === kind)
      const used = d.items.length
      const x = 22 + ((slot >= 0 ? slot : used) % 4) * 18
      // 挂墙的东西（画/钟/串灯）贴墙，不放地上
      const wall = (meta(kind) || {}).mount === 'wall'
      const y = wall ? 20 + (slot % 3) * 6 : 74 + (Math.floor((slot >= 0 ? slot : used) / 4) % 3) * 7
      return { x: Math.min(88, x), y: wall ? y : Math.min(84, y) }
    }

    function describe(d) {
      const st = settings()
      const owned = CATALOG.filter((c) => has(d, c.kind))
      const miss = CATALOG.filter((c) => !has(d, c.kind))
      const lines = []
      lines.push(`【我的小屋】余额 ${d.coins} ${st.coinName}`)
      lines.push(owned.length
        ? '屋里已有：' + owned.map((c) => c.name).join('、')
        : '屋里还空着，只有一块地毯大小的空地')
      if (miss.length) {
        lines.push('还没买：' + miss.map((c) => `${c.name}（${c.price} ${st.coinName}）`).join('、'))
      } else {
        lines.push('家具齐了，可以开始折腾摆位了')
      }
      return lines.join('\n')
    }

    function buy(kind) {
      const d = load()
      if (kind === FISH.kind) return { ok: false, message: '小鱼本来就在屋里，不用买' }
      const c = meta(kind)
      const st = settings()
      if (!c) return { ok: false, message: '没有这个家具：' + kind }
      if (has(d, kind)) return { ok: false, message: `屋里已经有${c.name}了` }
      if (d.coins < c.price) {
        return { ok: false, message: `还差 ${c.price - d.coins} ${st.coinName}（现在 ${d.coins}）` }
      }
      d.coins -= c.price
      const spot = freeSpot(d, kind)
      d.items.push({ kind, x: spot.x, y: spot.y, at: Date.now() })
      save(d)
      api.log.info(`买下 ${c.name}，剩 ${d.coins}`)
      return { ok: true, message: `买下了${c.name}，花了 ${c.price} ${st.coinName}，还剩 ${d.coins}`, state: d }
    }

    function place(kind, x, y) {
      const d = load()
      const it = find(d, kind)
      if (!it) return { ok: false, message: '还没有这件东西' }
      it.x = Math.max(0, Math.min(100, Number(x) || 0))
      it.y = Math.max(0, Math.min(100, Number(y) || 0))
      save(d)
      return { ok: true, message: '摆好了', state: d }
    }

    function sell(kind) {
      const d = load()
      if (kind === FISH.kind) return { ok: false, message: '不能把小鱼卖掉' }
      const c = meta(kind)
      if (!c || !has(d, kind)) return { ok: false, message: '没有这件东西' }
      d.items = d.items.filter((i) => i.kind !== kind)
      const back = Math.round(c.price / 2)
      d.coins += back
      save(d)
      return { ok: true, message: `把${c.name}收起来了，退回 ${back}`, state: d }
    }

    function preset() {
      const d = load()
      // 标准摆法：已有的挪到原位，没有的（够钱就）买一件放上去
      // 标准摆法：已有的挪到原位；只有这 8 件会顺手补买，装饰件不自动花钱
      const spots = {
        rug: [46, 80], desk: [33, 76], sofa: [60, 80], lamp: [6, 88],
        bed: [85, 78], snacks: [41, 92], frame: [93, 24], plant: [2, 94],
        shelf: [6, 68], fishtank: [57, 94], mirror: [93, 90], cushion: [33, 92],
        clock: [16, 14], lights: [72, 8], tv: [46, 27], pc: [69, 93],
        cooker: [25, 92], washer: [17, 70], fish: [49, 88],
      }
      const AUTO = new Set(['rug', 'desk', 'sofa', 'lamp', 'bed', 'snacks', 'frame', 'plant'])
      for (const [k, s] of Object.entries(spots)) {
        const it = d.items.find((i) => i.kind === k)
        if (it) { it.x = s[0]; it.y = s[1]; it.at = Date.now(); continue }
        if (!AUTO.has(k)) continue
        const c = meta(k)
        if (!c || d.coins < c.price) continue
        d.coins -= c.price
        d.items.push({ kind: k, x: s[0], y: s[1], at: Date.now() })
      }
      save(d)
      return { ok: true, message: '按标准布置摆好了', state: d }
    }

    // 她的心情：优先问 mood 模块，拿不到就读 plugins-data/aurabot/mood.json
    function moodInfo() {
      try {
        const m = api.use('mood')
        if (m) {
          const s = m.state && m.state()
          const v = Number(s && s.value)
          if (Number.isFinite(v)) return { value: Math.round(v), label: (m.label && m.label()) || '' }
        }
      } catch {}
      try {
        const f = join(api.dataDir(), '..', '..', 'mood.json')
        if (existsSync(f)) {
          const v = Number(JSON.parse(readFileSync(f, 'utf8')).value)
          if (Number.isFinite(v)) return { value: Math.round(v), label: '' }
        }
      } catch {}
      return null
    }

    function state() {
      const d = load()
      const st = settings()
      return {
        ok: true,
        coins: d.coins,
        coinName: st.coinName,
        earnToday: d.earn.got,
        earnPerDay: st.earnPerDay,
        mood: moodInfo(),
        items: d.items.map((i) => {
          const c = meta(i.kind) || (i.kind === FISH.kind ? FISH : null)
          return { kind: i.kind, name: c ? c.name : i.kind, x: i.x, y: i.y }
        }),
        catalog: CATALOG.map((c) => ({
          kind: c.kind, name: c.name, price: c.price, hint: c.hint, owned: has(d, c.kind),
        })),
      }
    }

    // ---------- 接口（面板用） ----------
    api.route('/state', () => state())
    const payload = async (req) => (await api.core.http.body(req)) || {}
    api.route('/buy', async (req) => {
      const b = await payload(req)
      return buy(String(b.kind || ''))
    })
    api.route('/place', async (req) => {
      const b = await payload(req)
      return place(b.kind, b.x, b.y)
    })
    api.route('/sell', async (req) => {
      const b = await payload(req)
      return sell(String(b.kind || ''))
    })
    api.route('/preset', () => preset())

    // ---------- 聊天里攒币 ----------
    api.on('activity', (a) => {
      if (!a || a.kind !== 'in' || !a.text) return
      const st = settings()
      if (st.earnPerMessage <= 0 || st.earnPerDay <= 0) return
      const d = load()
      if (d.earn.got >= st.earnPerDay) return
      const add = Math.min(st.earnPerMessage, st.earnPerDay - d.earn.got)
      d.coins += add
      d.earn.got += add
      save(d)
    })

    // ---------- 工具 ----------
    api.defineTool({
      name: 'room_status',
      description: '看看自己的小屋：有什么家具、还剩多少鱼币、还能买什么。',
      properties: {},
      required: [],
      execute: async () => describe(load()),
    })

    api.defineTool({
      name: 'room_buy',
      description: '用鱼币给自己的小屋买一件家具（地毯/木桌/深蓝沙发椅/鲸鱼台灯/一箱零食/小鱼画/盆栽）。',
      properties: { item: { type: 'string', description: '家具名字，比如「鲸鱼台灯」' } },
      required: ['item'],
      execute: async (args) => {
        const c = pick(args && args.item)
        if (!c) return '没有这种家具。能买的有：' + CATALOG.map((x) => x.name).join('、')
        return buy(c.kind).message
      },
    })

    api.defineTool({
      name: 'room_move',
      description: '把屋里的一件家具挪到新位置。x、y 是 0–100 的百分比（x 从左到右，y 从上到下）。',
      properties: {
        item: { type: 'string' },
        x: { type: 'number' },
        y: { type: 'number' },
      },
      required: ['item', 'x', 'y'],
      execute: async (args) => {
        const c = pick(args && args.item)
        if (!c) return '没有这种家具'
        return place(c.kind, args.x, args.y).message
      },
    })

    // ---------- 命令（只认主人） ----------
    api.command({
      name: '房间', aliases: ['小屋'], desc: '看看她的小屋和余额',
      run: async () => describe(load()),
    })
    api.command({
      name: '买', desc: '给小屋买家具，比如 /买 鲸鱼台灯',
      run: async (arg) => {
        const c = pick(arg)
        if (!c) return '能买的有：' + CATALOG.map((x) => `${x.name}（${x.price}）`).join('、')
        return buy(c.kind).message
      },
    })
    api.command({
      name: '给币', desc: '主人塞钱：/给币 100',
      run: async (arg) => {
        const n = Math.round(Number(arg))
        if (!Number.isFinite(n) || n === 0) return '要写个数字，比如 /给币 100'
        const d = load()
        d.coins = Math.max(0, d.coins + n)
        save(d)
        return `给了 ${n > 0 ? '+' : ''}${n}，现在 ${d.coins} ${settings().coinName}`
      },
    })

    // ---------- 让她知道自己有屋子 ----------
    api.context(() => {
      const d = load()
      const st = settings()
      const owned = CATALOG.filter((c) => has(d, c.kind)).map((c) => c.name)
      return owned.length
        ? `【我的小屋】${owned.join('、')}；余额 ${d.coins} ${st.coinName}`
        : ''
    })

    api.rule(() => '你有一间自己的小屋（房间模块）。想添家具就用 room_buy，想知道屋里什么样就用 room_status；'
      + '家具是你自己攒鱼币买的，聊起生活时可以自然地提到它们。')

    api.log.info('小鱼小屋已加载')
    return { state, buy, place, sell, preset, describe }
  },
}
