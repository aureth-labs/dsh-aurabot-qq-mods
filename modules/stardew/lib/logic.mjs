// 星露谷模块的纯逻辑：不碰网络、不碰进程，只做字符串和路径判断，方便单测。
// 这些函数都是从 index.mjs 里抽出来的，行为一点没改——踩过的坑都写在这儿了。

/** 从 SSE 文本里取出 JSON-RPC 回复（忽略 ": keep-alive" 这类注释行）。 */
export function parseSse(text) {
  for (const block of String(text ?? '').split(/\r?\n\r?\n/)) {
    const data = block
      .split(/\r?\n/)
      .filter((l) => l.startsWith('data:'))
      .map((l) => l.slice(5).trimStart())
      .join('\n')
    if (!data) continue
    let msg
    try {
      msg = JSON.parse(data)
    } catch {
      continue
    }
    if (msg && ('result' in msg || 'error' in msg)) return msg
  }
  throw new Error('游戏的回复里没有结果（连接可能中途断了）')
}

/**
 * 游戏此刻在不在存档里。
 *
 * ⚠ 2026-11-07 踩过的坑：游戏提示原文是「游戏还没有进入存档（在标题画面或正在加载）」，
 * 这里最早写成 `/还没进入存档/`，少了一个「有」字，永远匹配不上，
 * 结果每次点完存档都以为成功，实际一直停在标题画面，白玩好几局。
 * 改的时候别删「有」字，也别只匹配「标题画面」——加载中也要算没进去。
 */
const NOT_IN_SAVE = /还没(有)?进入存档|在标题画面|正在加载/

export function inSaveGame(text) {
  const s = String(text ?? '')
  if (!s.trim()) return false
  return !NOT_IN_SAVE.test(s)
}

/**
 * 后台那轮模型的自述里，只要带这些词就说明它在瞎报（它看不到真实执行结果，会自己编过程）。
 * 命中就整段丢掉，不往主人那儿送。
 */
const BAD_SELF_REPORT = /标题画面|进入存档|没进存档|连不上|开局失败/

export function looksLikeBadSelfReport(text) {
  return BAD_SELF_REPORT.test(String(text ?? ''))
}

/** 内容过长时中间截断，保留头尾（状态文本动辄上万字，全塞进上下文会爆）。 */
export function trim(text, limit = 12000) {
  const s = String(text ?? '')
  if (s.length <= limit) return s
  const head = 1500
  const tail = Math.max(0, limit - head)
  return `${s.slice(0, head)}\n……（中间省略 ${s.length - limit} 字）……\n${s.slice(-tail)}`
}

/**
 * 解析「玩几分钟」：支持 "5"、"12分钟"、"半个小时"、"1小时"、空。
 * 认不出来就用默认值（30 分钟），并把范围夹在 1~180。
 */
export function parseMinutes(arg, fallback = 30) {
  const raw = String(arg ?? '').trim()
  let n = 0
  // 先认"小时"，否则「1小时」会被下面的数字规则吃成 1 分钟
  const hour = raw.match(/(\d+(?:\.\d+)?)\s*(个)?\s*(小时|钟头)/)
  if (hour) n = Math.round(Number(hour[1]) * 60)
  else if (/半(个)?小时/.test(raw)) n = 30
  else {
    // 负数当没写（「-5」不是「5 分钟」）
    const m = raw.startsWith('-') ? null : raw.match(/(\d+)/)
    if (m) n = Number(m[1])
  }
  if (!Number.isFinite(n) || n <= 0) n = fallback
  return Math.max(1, Math.min(180, Math.round(n)))
}

/** 目标路径必须落在 base 目录内（防止 ../ 跑出去读别人东西）。 */
export function isInside(base, target) {
  const b = String(base ?? '').replace(/[\\/]+$/, '')
  const t = String(target ?? '')
  if (!b || !t) return false
  const sep = b.includes('\\') ? '\\' : '/'
  const norm = (p) => p.replace(/[\\/]+/g, sep)
  const nb = norm(b)
  const nt = norm(t)
  return nt === nb || nt.startsWith(nb + sep)
}

/**
 * 从存档目录里找出最新一次写盘的时间（毫秒）。
 * 收工汇报只认这个硬证据：sleep 工具说成功不算，文件真更新了才算。
 */
export function newestSaveMtime(saveDir, readdir, stat) {
  try {
    let best = 0
    for (const name of readdir(saveDir)) {
      try {
        const m = stat(`${saveDir}/${name}/${name}`)
        if (m > best) best = m
      } catch {
        // 这个存档目录里没有同名主文件，跳过
      }
    }
    return best
  } catch {
    return 0
  }
}
