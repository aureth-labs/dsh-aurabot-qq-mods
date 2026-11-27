/**
 * 写库时盖章（2026-11-20 爸爸定：走「运行时包一层」这条路）
 * 2026-11-21 改：密级也自己写，不再依赖插件有没有补丁
 *
 * 背景（2026-11-21 查证）：
 *   原版 dsh-aurabot-qq 的 memory.js 里**没有**密级这套东西——没有 gradeOf、没有 cls 字段、
 *   也没有「机密」这个词。密级是咱们当初直接改插件源码加进去的。
 *   所以别人装的干净插件，写进去的记忆根本没有 cls，模块必须自己补。
 *
 * 两条路同时走：
 *   1. 标签：写之前规整好，交给插件（这个插件认）
 *   2. 密级：写完库之后，用 node:sqlite 直接改那一条的 json 里补 cls
 *      （插件 add/update 都不认 cls，只能绕过它改库）
 *
 * 风险：
 *   - 这是接在别人的函数上，插件改签名可能失效 → 出问题一律退回原版，不抛错
 *   - 没有 node:sqlite（老 Node）→ 只做标签，不碰密级
 *   - 能关（设置里的 autoStamp）
 */

import { makeGrader } from './grade.mjs'
import { normalizeTags } from './tags.mjs'

// 2026-11-25 爸爸定：碎片压权重。
// 会话提炼会产出「先查一下」「这个是啥」这种短句，信息量很低，
// 但也不该直接删——删了就丢东西了。改成把重要度压到很低，
// 让遗忘曲线自己去清，既不显眼，也还留着。
// 判据故意做保守：只要沾一点实质内容就放过，宁可漏判别误伤。
const TRIVIAL_KEEP = [
  /\d/, // 有数字
  /[A-Za-z]{2,}/, // 有英文词
  /说|问|要求|答应|约定|决定|同意|拒绝|不想|喜欢|讨厌|告诉|记得|答应/, // 有表态
  /今天|明天|昨天|后天|下周|以后|之前|月|年|点|号/, // 有时间
  /工资|钱|上班|下班|吃饭|睡觉|生病|医院|买|卖|回来|回去/, // 有生活事件
]

/** 是不是「没什么实质内容的短句」 */
function isTrivialText(text) {
  const t = String(text || '').trim()
  if (!t) return true
  if (t.length >= 20) return false
  for (const re of TRIVIAL_KEEP) if (re.test(t)) return false
  return true
}
import { judgeFreshness } from './freshness.mjs'
import { statSync } from 'node:fs'

/**
 * 找插件的 memory.sqlite 在哪。
 *
 * 为什么不能写死一个相对路径：不同环境里模块数据目录和插件数据目录的相对位置不一样
 * （真实环境 .../aurabot/modules-data/memory-grade → ../../memory.sqlite 是对的，
 *  换到别的布局就错）。所以从数据目录往上逐层找，谁有 memory.sqlite 就是谁。
 *
 * @param {string} dataDir 模块自己的数据目录
 * @returns {string} 库的绝对路径，找不到返回空串
 */
export function findPluginDb(dataDir) {
  const dir = String(dataDir || '').trim()
  if (!dir) return ''
  let cur = dir
  // 最多往上找 6 层，别再往外跑了
  for (let i = 0; i < 6; i++) {
    const sep = cur.endsWith('\\') || cur.endsWith('/') ? '' : '\\'
    const candidate = cur + sep + 'memory.sqlite'
    try {
      if (statSync(candidate).isFile()) {
        // 关键：不能返回「模块自己的库」。
        // 模块的数据目录是 .../aurabot/modules-data/memory-grade，
        // 往上第一层就撞见自己的 memory.sqlite 了；
        // 插件真正的库在 .../aurabot/memory.sqlite（再往上两层）。
        // 判断办法：路径里带 modules-data 的，就是模块自己的，跳过继续往上找。
        if (!candidate.replace(/\\/g, '/').includes('/modules-data/')) return candidate
      }
    } catch {
      /* 没有就往上走 */
    }
    const parent = cur.replace(/[\\/][^\\/]+$/, '')
    if (!parent || parent === cur) break
    cur = parent
  }
  return ''
}

/**
 * 给一条刚写进去的记忆补 cls。
 * 只改那一条，不碰别人的。
 *
 * @param {string} dbFile memory.sqlite 的绝对路径
 * @param {string} id 这条的 id
 * @param {string} cls secret / internal / public
 * @param {object} [log]
 * @returns {boolean} 改成了没有
 */
export async function patchCls(dbFile, id, cls, log) {
  if (!dbFile || !id || !cls) return false
  let DatabaseSync
  try {
    ;({ DatabaseSync } = await import('node:sqlite'))
  } catch {
    return false // 这个运行时没有 node:sqlite，跳过
  }

  try {
    const db = new DatabaseSync(dbFile)
    try {
      const row = db.prepare('SELECT json FROM items WHERE id = ?').get(id)
      if (!row || !row.json) return false
      let item
      try {
        item = JSON.parse(row.json)
      } catch {
        return false
      }
      if (item.cls === cls) return true // 已经是了，不用改
      item.cls = cls
      db.prepare('UPDATE items SET json = ? WHERE id = ?').run(JSON.stringify(item), id)
      return true
    } finally {
      try {
        db.close()
      } catch {
        /* 关不掉就算了 */
      }
    }
  } catch (error) {
    log?.debug?.('[memory-grade] 补密级失败：' + error.message)
    return false
  }
}

/**
 * 补密级，失败了重试几次。
 *
 * 为什么要重试：写库和补密级是两步，中间可能赶上 SQLite 忙（插件自己也在写）、
 * 库被锁、或者刚好在重启。重试几次基本都能成，还不行就记个 warn 让人知道。
 *
 * @param {string} dbFile
 * @param {string} id
 * @param {string} cls
 * @param {object} [log]
 * @param {number} [tries] 最多试几次
 * @returns {Promise<boolean>}
 */
export async function patchClsWithRetry(dbFile, id, cls, log, tries = 3) {
  for (let i = 0; i < tries; i++) {
    const done = await patchCls(dbFile, id, cls, log)
    if (done) return true
    // 失败先等一下再来，给 SQLite 一点时间
    if (i < tries - 1) await new Promise((r) => setTimeout(r, 120 * (i + 1)))
  }
  log?.warn?.('[memory-grade] 补密级试了 ' + tries + ' 次没成功，这条（' + id + '）暂时没有密级')
  return false
}

/**
 * 把 memory.add 包一层：写之前规整标签，写之后补密级。
 *
 * @param {object} memory 插件导出的 memory 对象
 * @param {() => object} getSettings 每次现取设置（改面板不用重载）
 * @param {object} [opts]
 * @param {object} [opts.log] 日志口
 * @param {() => string} [opts.getDbFile] 返回 memory.sqlite 的绝对路径（拿不到就只做标签）
 * @returns {() => void} 还原函数
 */
// 2026-11-24 爸爸定：把插件的「去重加固」搬到模块来。
function numsOf(text) {
  return String(text || '').match(/\d+(?:\.\d+)?/g) || []
}

export function bigramSimilarity(a, b) {
  const s1 = String(a || '').replace(/\s+/g, '')
  const s2 = String(b || '').replace(/\s+/g, '')
  if (!s1 || !s2) return 0
  if (s1 === s2) return 1
  const grams = (s) => {
    const set = new Set()
    for (let i = 0; i < s.length - 1; i++) set.add(s.slice(i, i + 2))
    if (s.length === 1) set.add(s)
    return set
  }
  const g1 = grams(s1)
  const g2 = grams(s2)
  let same = 0
  for (const g of g1) if (g2.has(g)) same++
  return (2 * same) / (g1.size + g2.size || 1)
}

export function findLikelyDup(store, item, text) {
  if (!store) return null
  try {
    const rows = store.list({ limit: 300 }) || []
    const wantChat = String(item?.chatId || '')
    let best = null
    let bestSim = 0
    for (const m of rows) {
      if (m.state === 'archived') continue
      if (String(m.chatId || '') !== wantChat) continue
      const s = bigramSimilarity(m.text, text)
      if (s > bestSim) {
        bestSim = s
        best = m
      }
    }
    return best ? { item: best, sim: bestSim } : null
  } catch {
    return null
  }
}

export function shouldBlockAsNewFact(store, item, text, log) {
  const found = findLikelyDup(store, item, text)
  if (!found) return false
  const { item: dup, sim } = found
  const keepNums = numsOf(dup.text)
  if (!keepNums.length) return false
  const newNums = new Set(numsOf(text))
  const losesFact = keepNums.some((n) => !newNums.has(n))
  if (sim < 0.85 && losesFact) {
    log?.debug?.(
      '[memory-grade] 新记忆像旧条 [' +
        dup.id +
        '] 但会丢掉旧数字 ' +
        keepNums.join(',') +
        '（相似度 ' +
        sim.toFixed(2) +
        '），按新增处理',
    )
    return true
  }
  return false
}

export function wrapMemoryAdd(memory, getSettings, opts = {}) {
  const { log, getDbFile } = opts
  if (!memory || typeof memory.add !== 'function') {
    return () => {}
  }
  // 已经包过就别重复包（模块重载时可能走到）
  if (memory.__stampWrapped) {
    return memory.__stampWrapped
  }

  const original = memory.add

  function stampedAdd(item) {
    let cls = ''
    let pending = null
    try {
      const st = getSettings() || {}
      if (st.autoStamp === false) return original.call(this, item)
      if (!item || typeof item !== 'object') return original.call(this, item)
      // 已经带了就不重复算
      if (item.__stamped) return original.call(this, item)

      // 2026-11-24 爸爸定：写库前先做一遍「去重加固」。
      // 判成「另一件事」时在返回值上标出来，不改文本、不塞怪字符。
      let blockAsNew = false
      try {
        if (st.dedupeGuard !== false && typeof opts.getStore === 'function') {
          blockAsNew = shouldBlockAsNewFact(opts.getStore(), item, String(item.text ?? ''), log)
        }
      } catch {
        /* 拦截失败就按原来的走 */
      }

      const g = makeGrader(st)
      const text = String(item.text ?? '')
      // 先把标签归整好，插件看「家人」「知识」也会用到
      // 来源标签怎么定：
      //   source=auto 是聊天提炼出来的，按 chatId 分私聊/群聊
      //   其他 source（event/diary/tophub/knowledge/tool/panel）各有各的来源标签
      const srcForTags = item.source === 'auto' ? 'chat' : String(item.source || '')
      const tags = normalizeTags(item.tags, srcForTags, { chatId: item.chatId })
      // 自己判密级（不管插件认不认，先算出来）
      cls = g.classify({ text, tags, chatId: item.chatId, pin: item.pin })
      // 时效：现算，不往库里塞
      const fresh = judgeFreshness(text, { tags })

      const next = {
        ...item,
        tags,
        __stamped: true,
      }
      // 重要度没给的，用时效建议值（这个字段插件认）
      if (next.importance === undefined || next.importance === null) {
        next.importance = fresh.suggestImportance
      }
      // 2026-11-24 爸爸定：知识类的重要度提到 0.6 以上。
      // 2026-11-25 改成开关「过目不忘」：开着才抬，关掉就按原来的。
      // 抬到 0.6 的意义：插件那条遗忘曲线（重要度 < 0.6 才会算）就管不到知识类了，
      // 不用再靠插件补丁，也不用改插件代码。
      try {
        const st0 = getSettings() || {}
        const neverForget = st0.neverForget !== false // 默认开
        const isKnow = tags.includes('知识') || item.source === 'knowledge'
        if (neverForget && isKnow) {
          const cur = Number(next.importance) || 0
          if (cur < 0.6) next.importance = 0.6
        }
      } catch {
        /* 算不出来就按原来的 */
      }

      // 2026-11-25 爸爸定：碎片压权重（不删，只让它自然淡）。
      // 机密、置顶、知识、规矩、事实、长期印象、约定这些一律不压。
      try {
        const st1 = getSettings() || {}
        if (st1.trivialDecay !== false) {
          const raw = Number(st1.trivialImportance)
          const lowImp = Number.isFinite(raw) && raw >= 0 ? raw : 0.1
          const isKnow2 = tags.includes('知识') || item.source === 'knowledge'
          const keepIt =
            Boolean(item.pin) ||
            cls === 'secret' ||
            isKnow2 ||
            tags.includes('规矩') ||
            tags.includes('事实') ||
            tags.includes('长期印象') ||
            tags.includes('约定')
          if (!keepIt && isTrivialText(text)) {
            const cur = Number(next.importance)
            if (!Number.isFinite(cur) || cur > lowImp) {
              next.importance = lowImp
              next.trivial = true
            }
          }
        }
      } catch {
        /* 算不出来就按原来的 */
      }

      const r = original.call(this, next)
      // 判成「另一件事」时在返回值上标出来
      if (blockAsNew && r && typeof r === "object") {
        r.__forceNew = true
      }
      // 记住这条的 id，写完库之后补 cls
      // 2026-11-25 修：插件 add() 有两个返回分支——
      //   新增：{ ok: true, id: item.id }
      //   命中重复后更新：{ ok: true, updated: dup.id }   ← 这个没有 id！
      // 之前只认 r.id，导致「更新已有记录」那条永远补不上密级，
      // 库里就会留一批 internal，而按规则本该是 public。
      const targetId = r && (r.id || r.updated)
      if (r && r.ok !== false && targetId && cls) pending = { id: String(targetId), cls }
      return r
    } catch (error) {
      log?.warn?.('[memory-grade] 盖章包装出错，退回原版：' + error.message)
      return original.call(this, item)
    } finally {
      // 补 cls：不阻塞写入，失败了也不影响这条记忆存进去
      if (pending && getDbFile) {
        try {
          const dbFile = getDbFile()
          if (dbFile) {
            // 异步补，不等它，插件这个函数是同步的
            patchClsWithRetry(dbFile, pending.id, pending.cls, log)
              .then((done) => {
                if (!done) return
                // 2026-11-26 修：补完要让内存里那份也跟上。
                // 之前只改库不改 index，自检读到的永远是旧值，
                // 表现就是每小时只补 1 条、库里堆着一批判错的。
                try {
                  if (typeof opts.getStore === "function") {
                    const s = opts.getStore()
                    const it = s && typeof s.get === "function" ? s.get(pending.id) : null
                    if (it && it.cls !== pending.cls) it.cls = pending.cls
                  }
                } catch {
                  /* 内存更新失败不影响库 */
                }
              })
              .catch((e) => {
                log?.warn?.('[memory-grade] 补密级出错：' + e.message)
              })
          }
        } catch {
          /* 路径拿不到就算了 */
        }
      }
    }
  }

  memory.add = stampedAdd
  // 记下还原函数，模块停的时候要用
  memory.__stampWrapped = () => {
    try {
      memory.add = original
      delete memory.__stampWrapped
    } catch {
      /* 还原失败就算了，反正下次启动还会包 */
    }
  }
  return memory.__stampWrapped
}
