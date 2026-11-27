// 把桥返回的 JSON 变成她能读的短句。
//
// 全是纯函数：输入是桥的返回体，输出是字符串，不碰 api、不碰文件。
// 单独放一个文件，是为了能用固定的 JSON 覆盖空数据、缺字段、超长截断这些分支——
// 以前它们只能靠连接真桥间接验证。

/** 按码点截断（emoji 不会被切成半个）。 */
export function clip(text, max) {
  const s = String(text == null ? '' : text)
  const chars = Array.from(s)
  return chars.length > max ? chars.slice(0, max).join('') + '…' : s
}

export function bagText(bag) {
  if (!Array.isArray(bag) || !bag.length) return '空'
  return bag.map(function (b) { return (b.name || b.id) + '×' + (b.count == null ? 1 : b.count) }).join('、')
}

// 六项身体感受：字段名 + 显示名，顺序就是输出顺序。
const FEELINGS = [['satiety', '饱腹'], ['hydration', '口渴'], ['joy', '开心'], ['energy', '精力'], ['calm', '平静'], ['warmth', '暖和']]

export function briefStatus(body, opts) {
  // public：群聊里用。零花钱、背包、感受、想做还没做的事都是私事，只有主人私聊才看整份。
  const pub = !!(opts && opts.public)
  const p = body.position || {}
  const f = body.feeling || {}
  const lines = []
  const nowD = new Date()
  lines.push('现在：' + (nowD.getMonth() + 1) + '/' + nowD.getDate() + ' ' + String(nowD.getHours()).padStart(2, '0') + ':' + String(nowD.getMinutes()).padStart(2, '0'))
  lines.push('位置：' + (p.place || '还不知道') + (p.zoneName ? ' · ' + p.zoneName : ''))
  if (!pub && typeof body.wallet === 'number') lines.push('零花钱：' + body.wallet + ' 元（背包 ' + (body.bagSlots || 12) + ' 格）')
  if (!pub) lines.push('背包：' + bagText(body.bag))
  const doingLabel = body.doing && body.doing.label
  if (doingLabel) {
    let doing = '正在做：' + doingLabel
    const since = Number(body.doing.since)
    if (since > 0) {
      const mins = Math.round((Date.now() - since) / 60000)
      if (mins >= 1) doing += '（已经 ' + mins + ' 分钟）'
    }
    lines.push(doing)
  }
  const procs = Array.isArray(body.processes) ? body.processes : []
  const running = procs.filter(function (x) { return x && x.status === 'running' })
  if (!doingLabel && running.length) {
    lines.push('正在做：' + running.map(function (x) { return x.label || '没写名字' }).slice(0, 3).join('、'))
  }
  const queued = procs.filter(function (x) { return x && x.status === 'queued' })
  if (queued.length) {
    lines.push('排队中（' + queued.length + '）：' + queued.map(function (x) { return x.label || '没写名字' }).slice(0, 6).join('、'))
  }
  const feel = FEELINGS.filter(function (it) { return f[it[0]] != null })
    .map(function (it) { return it[1] + ' ' + f[it[0]] })
  if (!pub && feel.length) lines.push('感受：' + feel.join(' · '))
  if (!pub && body.mood) lines.push('心情：' + (body.mood.word || body.mood.key || '') + (body.mood.cause ? '（' + body.mood.cause + '）' : ''))
  if (body.weather) lines.push('天气：' + (body.weather.name || '') + ' ' + (body.weather.temp == null ? '' : body.weather.temp + '°C') + (body.weather.phase ? ' · ' + body.weather.phase : ''))
  if (!pub && Array.isArray(body.wishes) && body.wishes.length) {
    const w = body.wishes.filter(function (x) { return !x.done }).map(function (x) { return x.text }).slice(0, 5)
    if (w.length) lines.push('想做还没做：' + w.join('、'))
  }
  if (!pub) lines.push('状态数据：' + clip(JSON.stringify({ position: body.position, wallet: body.wallet, bagSlots: body.bagSlots, feeling: body.feeling, hunger: body.hunger, mood: body.mood && body.mood.word, doing: body.doing && body.doing.label, items: body.items, weather: body.weather ? { name: body.weather.name, temp: body.weather.temp, phase: body.weather.phase } : null }), 700))
  return lines.join('\n')
}

export function briefLook(body) {
  if (body && body.known === false) return String(body.note || '还不知道在哪里（游戏没连上？）')
  const lines = ['这里：' + (body.place || body.space || '') + (body.zone ? '（' + body.zone + '）' : '')]
  const objects = Array.isArray(body.objects) ? body.objects : []
  for (const o of objects) {
    const uses = (o.uses || []).map(function (u) {
      return u.id + (u.label ? '=' + u.label : '') + (u.buys && u.buys.length ? '［卖 ' + u.buys.join('、') + '］' : '')
    })
    lines.push('- ' + (o.name || o.id) + '(' + o.id + ')' + (o.supported === false ? ' [只能看]' : '') + '：' + (uses.join('、') || '看看就好'))
  }
  const exits = Array.isArray(body.exits) ? body.exits.map(function (e) { return (e.name || '') + '(' + e.id + ')' }) : []
  if (exits.length) lines.push('出口：' + exits.join('、'))
  // 家具清单已经在上面，不再附原始 JSON
  return clip(lines.join('\n'), 6000)
}

export function briefTask(body) {
  const lines = []
  if (body.label) lines.push('做了：' + body.label)
  const r = body.result || {}
  if (Array.isArray(r.happened) && r.happened.length) lines.push('发生：' + r.happened.join('；'))
  if (r.outcome) lines.push('结果：' + (typeof r.outcome === 'string' ? r.outcome : JSON.stringify(r.outcome)))
  if (typeof r.decision === 'string' && r.decision) lines.push('按作息：' + r.decision)
  if (r.pose && r.pose.label) lines.push('姿势：' + r.pose.label)
  if (r.view) lines.push('局面：' + r.view)
  if (r.bed && r.bed.text) lines.push('床上：' + r.bed.text)
  if (r.happening) lines.push('进行中：' + JSON.stringify(r.happening))
  if (typeof r.wallet === 'number') lines.push('零花钱：' + r.wallet + ' 元')
  if (Array.isArray(r.bag)) lines.push('背包：' + bagText(r.bag))
  if (r.position && r.position.zone) lines.push('现在在：' + r.position.zone + (r.position.scene ? '（' + r.position.scene + '）' : ''))
  // 成功时不再附原始 JSON：happened / wallet / bag 已经在上面了
  return lines.join('\n')
}

export function briefProcess(body) {
  const KIND = { body: '身体动作', chat: '聊天', think: '想事情', read: '看东西' }
  const STATUS = { queued: '排队中', running: '正在做', done: '已完成', failed: '失败', cancelled: '已取消' }
  function one(r) {
    const bits = []
    if (KIND[r.kind]) bits.push(KIND[r.kind])
    if (r.role === 'primary') bits.push('主要')
    if (STATUS[r.status]) bits.push(STATUS[r.status])
    let line = '· ' + (r.label || '(没写名字)') + '（' + bits.join('，') + '）'
    if (r.taskId) line += ' 任务号 ' + String(r.taskId).slice(0, 8)
    return line
  }
  if (body && body.process) {
    const p = body.process
    const bits = []
    if (KIND[p.kind] || p.kind) bits.push(KIND[p.kind] || p.kind)
    if (STATUS[p.status]) bits.push(STATUS[p.status])
    const tail = p.status === 'queued' ? '，等前面那件做完就开始' : ''
    return '登记好了：' + (p.label || '活动') + '（' + bits.join('，') + tail + '）'
  }
  const rows = Array.isArray(body && body.processes) ? body.processes : []
  if (!rows.length) return '现在没有在进行的活动。'
  const main = rows.find(function (r) { return r.id === body.primary })
  const head = '现在 ' + rows.length + ' 件事' + (main && main.label ? '（主要做：' + main.label + '）' : '') + '：'
  return head + '\n' + rows.map(one).join('\n')
}

export function briefCatalog(body) {
  const list = Array.isArray(body && body.objects) ? body.objects : []
  if (!list.length) return '没搜到。换个说法再搜，或者不带关键词翻页看看。'
  const total = Number(body.total || list.length)
  const offset = Number(body.offset || 0)
  const limit = Number(body.limit || 20) || 20
  const page = Math.floor(offset / limit) + 1
  const tail = body.nextOffset != null ? '，还有更多（下一页 offset=' + body.nextOffset + '）' : '，这是最后一页'
  const lines = ['搜到 ' + total + ' 样（第 ' + page + ' 页' + tail + '）：']
  for (const o of list) {
    const uses = (o.uses || []).map(function (u) { return u.id }).filter(Boolean).join('/')
    lines.push('· ' + (o.name || o.id) + ' ' + o.id + ' @' + (o.space || '?') + '：' + (uses ? '用 ' + uses : '只能看'))
  }
  return clip(lines.join('\n'), 3200)
}

export function briefRaw(body) {
  const lines = []
  if (body && body.label) lines.push('做了：' + body.label)
  // cabin_stop 返回 { stopped: true/false, note }（不是数组），note 本身就是人话，不用再贴原文。
  if (body && typeof body.stopped === 'boolean') return body.note || (body.stopped ? '已经叫停了' : '现在没在做事')
  if (body && Array.isArray(body.stopped) && body.stopped.length) lines.push('停下了：' + body.stopped.join('、'))
  if (body && body.status) lines.push('状态：' + body.status)
  lines.push('原始返回：' + clip(JSON.stringify(body), 1500))
  return lines.join('\n')
}
