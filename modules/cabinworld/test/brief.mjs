// 简报函数的单测：直接喂 JSON，不连桥、不碰文件。
// 这些兜底分支（空数据 / 缺字段 / 超长截断）以前只能靠连接真桥间接验证。
// 用法：node test/brief.mjs

import { clip, briefStatus, briefLook, briefTask, briefProcess, briefCatalog, briefRaw } from '../lib/brief.mjs'

const ok = (cond, label, extra) => {
  if (cond) { console.log('OK ' + label + (extra ? ' - ' + extra : '')); return }
  console.error('FAIL ' + label + (extra ? ' - ' + extra : ''))
  process.exitCode = 1
}

// ---- clip：按码点截断，emoji 不能被切成半个 ----
ok(clip('abc', 10) === 'abc', 'clip: 短文本原样')
ok(clip('abcdef', 3) === 'abc…', 'clip: 超长加省略号')
ok(clip('😀😀😀😀😀', 2) === '😀😀…', 'clip: emoji 不被切半', clip('😀😀😀😀😀', 2))
ok(clip(null, 5) === '', 'clip: null 变空串')

// ---- briefStatus：空数据要给出可读的兜底，不能出现 undefined ----
const empty = briefStatus({})
ok(empty.indexOf('位置：还不知道') >= 0, 'status: 空数据位置兜底')
ok(empty.indexOf('背包：空') >= 0, 'status: 空数据背包兜底')
ok(empty.indexOf('undefined') < 0 && empty.indexOf('NaN') < 0, 'status: 空数据不出现 undefined/NaN')
ok(empty.indexOf('正在做') < 0, 'status: 没做事时不输出「正在做」')
ok(empty.indexOf('零花钱') < 0, 'status: 没钱包时不输出零花钱')

const doing = briefStatus({ doing: { label: '在床上休息', since: 0 } })
ok(doing.indexOf('正在做：在床上休息') >= 0, 'status: 有 doing 时输出')
ok(doing.indexOf('已经') < 0, 'status: since=0 不输出时长')

const running = briefStatus({ processes: [{ id: 'p1', status: 'running', label: '走去公园' }, { id: 'p2', status: 'queued', label: '洗澡' }] })
ok(running.indexOf('正在做：走去公园') >= 0, 'status: 无 doing 时用 running 兜底')
ok(running.indexOf('排队中（1）：洗澡') >= 0, 'status: 输出排队中')

const full = briefStatus({
  position: { place: '小屋旁的公园', zoneName: '长椅' },
  wallet: 42, bagSlots: 12,
  bag: [{ name: '苹果', count: 2 }, { id: 'bread' }],
  feeling: { satiety: 70, joy: 0, energy: null },
  hunger: '有点饿', mood: { word: '平静', cause: '晒太阳' },
  weather: { name: '晴', temp: 22, phase: '白天' },
  wishes: [{ text: '想喝汤', done: false }, { text: '想睡觉', done: true }]
})
ok(full.indexOf('位置：小屋旁的公园 · 长椅') >= 0, 'status: 完整位置带分区')
ok(full.indexOf('零花钱：42 元（背包 12 格）') >= 0, 'status: 钱包与格数')
ok(full.indexOf('苹果×2、bread×1') >= 0, 'status: 背包缺 count 时按 1 算')
ok(full.indexOf('饱腹 70') >= 0 && full.indexOf('开心 0') >= 0, 'status: 感受 0 值仍然输出')
ok(full.indexOf('精力') < 0, 'status: 感受为 null 时跳过')
ok(full.indexOf('心情：平静（晒太阳）') >= 0, 'status: 心情带起因')
ok(full.indexOf('天气：晴 22°C · 白天') >= 0, 'status: 天气')
ok(full.indexOf('想做还没做：想喝汤') >= 0 && full.indexOf('想睡觉') < 0, 'status: 只列没做完的心愿')
ok(full.indexOf('状态数据：') >= 0, 'status: 末尾附状态数据')

// ---- briefLook ----
ok(briefLook({ known: false, note: '游戏没连上' }) === '游戏没连上', 'look: known=false 用 note')
ok(briefLook({ known: false }) === '还不知道在哪里（游戏没连上？）', 'look: known=false 无 note 用兜底')
const look = briefLook({
  place: '小卖部', zone: '店内',
  objects: [
    { id: 'shelf', name: '货架', uses: [{ id: 'buy', label: '买', buys: ['苹果', '面包'] }] },
    { id: 'poster', name: '海报', supported: false },
    { id: 'chair', uses: [] }
  ],
  exits: [{ id: 'park', name: '公园' }]
})
ok(look.indexOf('这里：小卖部（店内）') >= 0, 'look: 位置带分区')
ok(look.indexOf('货架(shelf)：buy=买［卖 苹果、面包］') >= 0, 'look: 用途带售价')
ok(look.indexOf('海报(poster) [只能看]') >= 0, 'look: supported=false 标注只能看', look.split('\n').find(function (l) { return l.indexOf('poster') >= 0 }))
ok(look.indexOf('chair') >= 0 && look.indexOf('看看就好') >= 0, 'look: 无用途时说看看就好')
ok(look.indexOf('出口：公园(park)') >= 0, 'look: 出口')

// ---- briefTask ----
ok(briefTask({}) === '', 'task: 空对象输出空串')
const task = briefTask({
  label: '洗手',
  result: { happened: ['走到水池', '打开水龙头'], pose: { label: '站着' }, wallet: 30, bag: [{ name: '香皂', count: 1 }], position: { zone: '洗手间', scene: '镜子前' }, outcome: { ok: true } }
})
ok(task.indexOf('做了：洗手') >= 0, 'task: 动作名')
ok(task.indexOf('发生：走到水池；打开水龙头') >= 0, 'task: 多件事用分号连')
ok(task.indexOf('姿势：站着') >= 0, 'task: 姿势')
ok(task.indexOf('零花钱：30 元') >= 0, 'task: 钱包')
ok(task.indexOf('背包：香皂×1') >= 0, 'task: 背包')
ok(task.indexOf('现在在：洗手间（镜子前）') >= 0, 'task: 位置')
ok(task.indexOf('结果：{"ok":true}') >= 0, 'task: 非字符串结果转 JSON')

// ---- briefProcess ----
ok(briefProcess({}) === '现在没有在进行的活动。', 'process: 空列表')
ok(briefProcess({ process: { label: '吃饭', kind: 'body', status: 'queued' } }).indexOf('登记好了：吃饭（身体动作，排队中，等前面那件做完就开始）') >= 0, 'process: 登记单件')
const plist = briefProcess({ processes: [{ id: 'a', kind: 'think', status: 'running', role: 'primary', label: '想事情', taskId: 'abcdefgh12345' }, { id: 'b', status: 'done', label: '看书' }], primary: 'a' })
ok(plist.indexOf('现在 2 件事（主要做：想事情）') >= 0, 'process: 列表带主事件')
ok(plist.indexOf('任务号 abcdefgh') >= 0, 'process: 任务号取前 8 位')
ok(plist.indexOf('· 看书（已完成）') >= 0, 'process: 未知 kind 时不输出类型')

// ---- briefCatalog ----
ok(briefCatalog({}) === '没搜到。换个说法再搜，或者不带关键词翻页看看。', 'catalog: 空结果')
const cat = briefCatalog({ total: 42, offset: 20, limit: 20, nextOffset: 40, objects: [{ id: 'sofa', name: '沙发', space: '客厅', uses: [{ id: 'sit' }, { id: 'sleep' }] }, { id: 'lamp', space: '客厅' }] })
ok(cat.indexOf('搜到 42 样（第 2 页，还有更多（下一页 offset=40））') >= 0, 'catalog: 分页信息')
ok(cat.indexOf('沙发 sofa @客厅：用 sit/sleep') >= 0, 'catalog: 用途用斜杠连')
ok(cat.indexOf('lamp @客厅：只能看') >= 0, 'catalog: 无用途时说只能看')
const last = briefCatalog({ total: 2, objects: [{ id: 'a' }] })
ok(last.indexOf('这是最后一页') >= 0, 'catalog: 没有 nextOffset 就是最后一页')

// ---- briefRaw ----
ok(briefRaw({}).indexOf('原始返回：{}') >= 0, 'raw: 空对象也给原始返回')
const raw = briefRaw({ label: '走过去', stopped: ['看书', '发呆'], status: 'done' })
ok(raw.indexOf('做了：走过去') >= 0 && raw.indexOf('停下了：看书、发呆') >= 0 && raw.indexOf('状态：done') >= 0, 'raw: 三个字段都在')
