// 价格监控的纯逻辑：价格解析、商品指纹、好价判定、匹配打分。
//
// 好价判定沿用 什么值得买 好价监控（extensions/smzdm-monitor）的筛选口径，
// 但只保留两条：超级好价、早期好价。那边还有均衡热度、高讨论、早期强信号、升温好价，
// 这里都不参与判定。
//
// 这里不碰网络、不碰磁盘、不碰 api，全部是纯函数，方便直接单测。

/**
 * 从什么值得买的 article_price 文本里取当前售价。
 * 「68.52元（需买2件，共137.04元）」是单价；「3590元（淘金币可抵25元起）」是抵扣前的价格。
 * 返还额、满减门槛、赠品面值、原价都不是售价，要跳过。
 */
export function parsePrice (text) {
  const raw = String(text === undefined || text === null ? '' : text).replace(/,/g, '')
  const values = []
  const re = /(\d+(?:\.\d+)?)\s*元/g
  let m
  while ((m = re.exec(raw)) !== null) {
    const before = raw.slice(Math.max(0, m.index - 16), m.index)
    // 返还额、满减门槛、赠品面值、原价、抵扣额：都不是当前售价
    if (/(?:返(?:还)?|退(?:还)?|赠|送|赔|满|减|立减|省|原价|价值|面值|券面额|可抵|抵扣|抵)\s*$/.test(before)) continue
    const n = Number(m[1])
    if (Number.isFinite(n) && n > 0) values.push(n)
    // 只取第一个出现的「元」金额作为主价格；后面括号里的通常是用券 / 凑单备注
    break
  }
  if (!values.length) return null
  return Math.round(values[0] * 100) / 100
}

/** 只看数字金额（给面板显示用）：19.9元（需用券）→ 19.9 */
export function formatPrice (value) {
  if (value === null || value === undefined || value === '') return '—'
  const n = Number(value)
  if (!Number.isFinite(n)) return '—'
  return (Math.round(n * 100) / 100).toString()
}

/**
 * 商品指纹：把同一件商品在不同爆料里的标题归一成同一个 key。
 * 这里只做轻量归一：去括号里的用券 / 满减说明、去促销前缀、去标点、压空白。
 * 归一不到足够长度就返回空串（不参与历史价比较），避免把一堆短标题混成一件商品。
 */
export function productKey (title, minLength = 6) {
  let text = String(title || '').toLowerCase()
  text = text.replace(/<[^>]+>/g, '')
  text = text.replace(/[[](?:[^\]]*(?:券|优惠|返|plus|会员|满减|到手|需买|凑单|可抵|补贴))[^\]]*[]]/g, '')
  text = text.replace(/[（(](?:[^）)]*(?:券|优惠|返|plus|会员|满减|到手|需买|凑单|可抵|补贴))[^）)]*[）)]/g, '')
  const promo = ['移动端', 'plus会员', '88vip', '值友专享', '今日必买', '拼多多百亿补贴', '百亿补贴', '淘金币可用', '历史低价', '历史新低', '新低价', '新低', '限地区', '限时', '临期品', '凑单品', '需用券', '券后', '下单立减', '满减', '可用券', '可用', '官方旗舰店', '旗舰店']
  for (const word of promo) text = text.split(word).join('')
  text = text.replace(/\d+(?:\.\d+)?\s*元/g, '')
  text = text.replace(/[（(](?:\d+色|多色|多款)可选[）)]/g, '')
  text = text.replace(/[^\w\u4e00-\u9fff]+/g, '')
  if (text.length < minLength) return ''
  return text.slice(0, 80)
}

/** 值票支持率：值 / (值 + 不值)，没人投票返回 null。 */
export function scoreRate (worthy, unworthy) {
  const w = Math.max(0, Number(worthy) || 0)
  const u = Math.max(0, Number(unworthy) || 0)
  if (w + u <= 0) return null
  return w / (w + u)
}

/** 综合热度分：评论 * 3 + 收藏 * 2 + 值票。和 smzdm-monitor 的公式一致。 */
export function heatScore ({ comments = 0, collection = 0, worthy = 0 } = {}) {
  return Math.max(0, Number(comments) || 0) * 3 + Math.max(0, Number(collection) || 0) * 2 + Math.max(0, Number(worthy) || 0)
}

const PATHS = [
  {
    key: 'super',
    label: '超级好价',
    // 值票、评论、收藏都充分，社区已经把它投成了成熟好价
    test: ({ comments, worthy, collection, score, meetsRate }) =>
      comments >= 20 && worthy >= 20 && collection >= 10 && score >= 120 && meetsRate(0.90),
  },
  {
    key: 'early',
    label: '早期好价',
    // 信号刚起来：值票和评论够看，收藏也在涨，但还没到超级好价
    test: ({ comments, worthy, collection, engagement, score, meetsRate }) =>
      worthy >= 4 && comments >= 6 && collection >= 4 && engagement >= 16 && score >= 35 && meetsRate(0.95),
  },
]

/**
 * 这个商品算不算好价。返回 { quality: 'super'|'early'|'', label }。
 * 基础门槛：至少 2 个值票或 2 条评论，售罄 / 过期直接不算。
 *
 * 「值票支持率」有一个受控的小样本例外：值票 ≥ 6、不值 ≤ 1 时按 85% 算，
 * 免得「6 值 : 1 不值」被 95% 门槛一票否决。这是 smzdm-monitor 原样的规则。
 */
export function qualityOf (item = {}) {
  const comments = Math.max(0, Number(item.comments) || 0)
  const collection = Math.max(0, Number(item.collection) || 0)
  const worthy = Math.max(0, Number(item.worthy) || 0)
  const unworthy = Math.max(0, Number(item.unworthy) || 0)
  const soldOut = Boolean(item.soldOut)
  const ended = Boolean(item.ended)
  const base = { comments, collection, worthy, unworthy }
  const engagement = comments + collection + worthy
  const score = heatScore(base)
  const rate = scoreRate(worthy, unworthy)
  const none = { quality: '', label: '', score, rate }
  if (soldOut || ended) return none
  if (worthy < 2 && comments < 2) return none
  // 值票为 0 时没有支持率可言，按 0 处理
  const actual = rate === null ? 0 : rate
  // 全局下限：票数够多还低于 85% 的直接不算好价
  if (worthy + unworthy >= 3 && actual < 0.85) return none
  // 小样本例外：值 ≥6、不值 ≤1 时，允许 85% 继续参加路径判断
  const meetsRate = (required) =>
    actual >= required || (worthy >= 6 && unworthy <= 1 && actual >= 0.85)
  const probe = { ...base, engagement, score, rate: actual, meetsRate }
  for (const path of PATHS) {
    if (path.test(probe)) return { quality: path.key, label: path.label, score, rate }
  }
  return none
}

/** 文本归一成用来比对的词袋：小写、去标点、按空白切。 */
function tokens (text) {
  return String(text || '')
    .toLowerCase()
    .replace(/[^\w\u4e00-\u9fff]+/g, ' ')
    .split(/\s+/)
    .filter(Boolean)
}

/**
 * 品牌 / 型号的中英对照：爆料标题里常常只有英文品牌名（Bambu Lab），
 * 用户说的是中文（拓竹）。这里是「一方出现另一方的别名也算命中」的词表。
 * 只放确定的对照，宁缺毋滥——错的对照比没有对照更糟。
 */
const BRAND_ALIASES = [
  ['拓竹', 'bambu', 'bambulab', 'bambu lab'],
  ['小米', 'xiaomi', 'mi'],
  ['红米', 'redmi'],
  ['华为', 'huawei'],
  ['荣耀', 'honor'],
  ['苹果', 'apple', 'iphone', 'ipad', 'macbook', 'airpods'],
  ['三星', 'samsung', 'galaxy'],
  ['索尼', 'sony'],
  ['任天堂', 'nintendo', 'switch'],
  ['戴森', 'dyson'],
  ['德龙', 'delonghi', 'de\'longhi'],
  ['飞利浦', 'philips'],
  ['美的', 'midea'],
  ['格力', 'gree'],
  ['海尔', 'haier'],
  ['九阳', 'joyoung'],
  ['苏泊尔', 'supor'],
  ['松下', 'panasonic'],
  ['西门子', 'siemens'],
  ['博世', 'bosch'],
  ['联想', 'lenovo', 'thinkpad', 'thinkbook'],
  ['华硕', 'asus', 'rog'],
  ['微星', 'msi'],
  ['技嘉', 'gigabyte'],
  ['英特尔', 'intel'],
  ['英伟达', 'nvidia', 'geforce', 'rtx'],
  ['罗技', 'logitech'],
  ['雷蛇', 'razer'],
  ['anker', '安克'],
  ['绿联', 'ugreen'],
  ['倍思', 'baseus'],
  ['西部数据', 'wd', 'western digital'],
  ['希捷', 'seagate'],
  ['铠侠', 'kioxia', 'toshiba', '东芝'],
  ['闪迪', 'sandisk'],
  ['金士顿', 'kingston'],
  ['芝奇', 'gskill', 'g.skill'],
  ['海盗船', 'corsair'],
  ['猫头鹰', 'noctua'],
  ['利民', 'thermalright'],
  ['美的', 'midea'],
  ['科沃斯', 'ecovacs'],
  ['石头', 'roborock'],
  ['追觅', 'dreame'],
  ['云鲸', 'narwal'],
  ['九号', 'segway'],
  ['小牛', 'niu'],
  ['雅迪', 'yadea'],
  ['爱玛', 'aima'],
  ['耐克', 'nike'],
  ['阿迪达斯', 'adidas'],
  ['李宁', 'lining'],
  ['安踏', 'anta'],
  ['优衣库', 'uniqlo'],
  ['宜家', 'ikea'],
  ['乐高', 'lego'],
  ['万代', 'bandai', 'gundam', '高达'],
  ['泡泡玛特', 'popmart', 'pop mart'],
  ['鸣潮', 'wuthering'],
]

/** 归一：小写、去空白和标点，只留字母数字和汉字。用来做包含判断。 */
const squash = (text) => String(text || '').toLowerCase().replace(/[^a-z0-9\u4e00-\u9fff]+/g, '')

const aliasTable = (() => {
  const map = new Map()
  for (const group of BRAND_ALIASES) {
    const all = group.flatMap((name) => [squash(name), ...String(name).split(/\s+/).map(squash)]).filter((name) => name.length >= 2)
    for (const name of group.map(squash).filter(Boolean)) {
      map.set(name, new Set(all))
    }
  }
  return map
})()

/** 这个片段是不是某个品牌名的别名（任一方向都算），返回它的全部等价写法。 */
function brandEquivalents (part) {
  const key = squash(part)
  if (!key) return null
  const direct = aliasTable.get(key)
  if (direct) return direct
  for (const [, names] of aliasTable) if (names.has(key)) return names
  return null
}

/**
 * 型号的「子串」其实不是同一件东西：A1 / A1C / A1mini、K80 / K80 Pro。
 * 英文数字片段后面紧跟字母（A1C、A1mini）就算不同型号，除非用空格隔开（A1 C 是另一个东西，但 A1 与 A1C 不是）。
 */
// 「A1 Pro」「K80 至尊版」这类：和 A1 是同一系列的另一个版本，算相关但不算同一件商品。
// 注意 A1mini / A1C 是「黏在一起」的另一个 SKU，不在这里。
const MODEL_VARIANT_WORDS = ['pro', 'plus', 'ultra', 'max', 'se', 'turbo', '至尊', '尊享', '加强', '增强', '旗舰', '新款', '套装', '单机', '标准', '标配']

/**
 * 型号命中程度：1 = 就是它；0.5 = 同系列的另一个版本（A1 Pro）；0 = 不是它（A1C / A1mini / A2L）。
 * 分开算，是为了让「A1 Pro」排得比「A2L」靠前，又不会被当成「A1」本身、拿它的价格冒充。
 */
function modelHit (hayJoined, part) {
  const needle = squash(part)
  if (!needle) return 0
  const numeric = /[0-9]/.test(needle)
  let from = 0
  for (;;) {
    const at = hayJoined.indexOf(needle, from)
    if (at < 0) return 0
    const after = hayJoined.slice(at + needle.length)
    // 只看紧跟的**英文字母**：A1C / A1mini 是另一个 SKU。
    // 中文不能当型号后缀——「A1 热卖」「A1 打印机」里 a1 后面是中文，仍然是 A1 本身。
    const tail = (after.match(/^[a-z]+/) || [''])[0]
    if (!tail) return 1
    if (!numeric) return 1
    if (MODEL_VARIANT_WORDS.includes(tail)) return 0.5
    from = at + 1
  }
}

/**
 * 把查询切成「词」：空格之外，还要在中文和字母/数字的交界处断开。
 * 「拓竹A1」→ ['拓竹','a1']，「红米K80」→ ['红米','k80']，「索尼WH-1000XM5」→ ['索尼','wh1000xm5']。
 * 不切的话「拓竹A1」整串只能匹配到标题里真有「拓竹A1」四个字的耗材，
 * 反而认不出「Bambu Lab A1」这种正常写法。
 */
export function splitQuery (query) {
  const raw = String(query || '').trim().toLowerCase()
  if (!raw) return []
  const parts = []
  for (const chunk of raw.split(/\s+/).filter(Boolean)) {
    // 中文段 / 非中文段交替切开；数字和字母不分家（wh-1000xm5 是一个型号）
    const seg = chunk.match(/[\u4e00-\u9fff]+|[^\u4e00-\u9fff]+/g) || []
    let buffer = ''
    const flush = () => { if (buffer) { parts.push(buffer); buffer = '' } }
    for (const piece of seg) {
      if (/^[\u4e00-\u9fff]+$/.test(piece)) {
        // 中文后面跟着型号时，每个中文词都是一个品牌/品类词，单独成词更稳
        flush()
        if (piece.length <= 6) parts.push(piece)
        else {
          // 长中文串（「头戴式无线降噪耳机」）保留整串，匹配时会按两字片段兜底
          parts.push(piece)
        }
      } else {
        // 字母数字段：去掉中间的空格和连字符，粘成一个型号词
        const merged = piece.replace(/[^a-z0-9]+/g, '')
        if (merged) buffer += merged
      }
    }
    flush()
  }
  return [...new Set(parts)]
}

/**
 * 用户输入「switch 2」这种查询和爆料标题的匹配打分。
 * 返回 0~1；全部关键词都命中才算高相关，只命中一部分算候选。
 * 中文按「输入串是否出现在标题里」判断，英文按词边界；
 * 品牌名认中英对照（拓竹 = Bambu Lab），型号按边界判断（A1 不命中 A1C / A1mini）。
 */
export function matchScore (query, title) {
  const q = String(query || '').trim()
  if (!q) return 0
  const haystack = String(title || '').toLowerCase()
  if (!haystack) return 0
  const hay = tokens(title)
  const haySet = new Set(hay)
  const hayJoined = hay.join('')
  const haySquash = squash(title)
  const parts = splitQuery(q)
  const cjk = /[\u4e00-\u9fff]/.test(q)
  let hit = 0
  for (const part of parts) {
    const piece = squash(part)
    if (!piece) continue
    // 1) 品牌别称：中文写拓竹、标题写 Bambu Lab 也算命中
    const brands = brandEquivalents(part)
    if (brands && [...brands].some((name) => haySquash.includes(name))) { hit++; continue }
    // 2) 型号（字母+数字）只按边界判断：A1 命中 A1，不命中 A1C / A1mini / A2L；
    //    A1 Pro 算半个（同系列的另一个版本）。这里**不能**回落到「包含即命中」，否则 A1C 又会被算成 A1。
    //    纯数字（「switch 2」里的 2）不是型号，按词边界单独判断。
    if (/[a-z]/.test(piece) && /[0-9]/.test(piece)) {
      hit += modelHit(haySquash, piece)
      continue
    }
    if (/^[0-9]+$/.test(piece)) {
      if (haySet.has(piece) || new RegExp('(^|[^0-9])' + piece + '([^0-9]|$)').test(haySquash)) hit++
      continue
    }
    if (cjk) {
      // 中文没有词边界：整串在标题里出现就算命中
      if (hayJoined.includes(part) || haySquash.includes(piece)) hit++
      else if (part.length >= 2) {
        // 退一步：按两字片段命中率算，避免「索尼降噪耳机」整串不在标题里就判 0
        let small = 0
        for (let i = 0; i + 2 <= part.length; i++) if (hayJoined.includes(part.slice(i, i + 2))) small++
        const total = Math.max(1, part.length - 1)
        const cover = small / total
        if (cover >= 0.6) hit += cover
      }
    } else if (haySet.has(part) || hayJoined.includes(part) || haySquash.includes(piece)) {
      hit++
    }
  }
  // 型号（字母+数字）匹配不上时，别的词命中再多也不是这件商品。
  // 「拓竹 A1 打印机」对「Bambu Lab A1mini」：品牌和品类都中，型号却是另一个，不能靠这两项混进强相关。
  const models = parts.filter((part) => /[a-z]/.test(part) && /[0-9]/.test(part))
  if (models.length) {
    const hits = models.map((part) => modelHit(haySquash, part))
    const best = hits.length ? Math.max(...hits) : 1
    // 型号没对上：别的词命中再多也只是「沾边」，封在弱相关以下（0.4），不进强候选
    if (best === 0) return Math.min(0.4, parts.length ? hit / parts.length : 0)
    // 型号只是同系列的另一版（A1 Pro / K80 Pro）：封顶 0.6，排在真型号后面
    if (best < 1) return Math.min(0.6, (parts.length ? hit / parts.length : 0) + 0.15)
  }
  const base = parts.length ? hit / parts.length : 0
  // 完全匹配整串额外加分，让最贴切的那条排在前面
  const exact = haySquash.includes(squash(q)) ? 0.15 : 0
  return Math.min(1, base + exact)
}

/**
 * 配件 / 耗材 / 赠品这类「沾了商品名但不是商品本身」的词。
 * 查询里自己带了这些词（「A1 打印板」）就不降权；没带就压到商品后面去，
 * 免得「拓竹 A1」先列出 17 块的贴膜和 18 块的耗材。
 */
const ACCESSORY_WORDS = [
  '耗材', '线材', '配件', '打印板', 'pei板', 'peI板'.toLowerCase(), '热床', '喷头', '喷嘴', '贴膜', '保护膜', '钢化膜',
  '保护壳', '保护套', '手机壳', '收纳包', '收纳盒', '清洁', '润滑', '干燥箱', '封箱', '支架', '底座', '转接',
  '延长线', '数据线', '充电线', '电源线', '适配器', '充电器', '替换', '备件', '零件', '工具包', '挤出头',
  '挤出机', '热端', '喷嘴套件', '耗材架', '料盘', '干燥剂', '胶水', '脱模', '底板', '离型膜', '补光灯',
]

const hasAccessoryWord = (text) => {
  const t = String(text || '').toLowerCase()
  return ACCESSORY_WORDS.some((word) => t.includes(word))
}

/**
 * 一条结果对这次查询的相关度分层，用来决定「先看哪些」：
 *   2 = 强相关且不是配件；1 = 强相关但是配件；0 = 弱相关（只是沾了关键词）。
 * 排序按分层优先、同层再按价格，这样最便宜的是「这件商品的最便宜」，而不是最便宜的配件。
 */
export function relevanceOf (query, item) {
  const title = String((item && item.title) || '')
  const score = matchScore(query, title)
  const strong = score >= 0.6
  const accessory = hasAccessoryWord(title) && !hasAccessoryWord(query)
  return {
    score,
    tier: strong ? (accessory ? 1 : 2) : 0,
    accessory,
  }
}

/**
 * 按「相关度分层 + 价格」挑出要展示的几条。
 * 返回 { picked, pool, weak }：weak 表示没有强相关结果、只能拿弱相关的凑数。
 */
export function rankResults (query, items, topN = 3) {
  const limit = Math.max(1, Math.min(20, Number(topN) || 3))
  const list = (Array.isArray(items) ? items : [])
    .filter((item) => item && Number.isFinite(Number(item.price)) && Number(item.price) > 0)
    .map((item) => ({ item, ...relevanceOf(query, item) }))
  if (!list.length) return { picked: [], pool: [], weak: false, hasMain: false, onlyAccessory: false }
  const strong = list.filter((row) => row.tier > 0)
  const pool = strong.length ? strong : list
  const main = list.filter((row) => row.tier === 2)
  const picked = [...pool]
    .sort((a, b) => (b.tier - a.tier) || (a.item.price - b.item.price))
    .slice(0, limit)
    .map((row) => Object.assign(row.item, {
      // 面板 / 文字里能看出这条是不是配件、相关度够不够
      accessory: row.accessory,
      matchScore: Math.round(row.score * 100) / 100,
    }))
  return {
    picked,
    pool,
    weak: !strong.length,
    // 有没有「强相关又不是配件」的结果：没有就说明只搜到耗材周边
    hasMain: main.length > 0,
    onlyAccessory: main.length === 0 && strong.length > 0,
  }
}

/**
 * 从一句聊天里抠出「品牌 + 型号」形式的商品名，抠不出来返回空串。
 * 只在中文是**已知品牌**或短的品类词时才算商品名，
 * 否则「没有整机价 A1」这种会被当成商品名，搜出一堆无关结果。
 */
const CATEGORY_WORDS = ['打印机', '手机', '耳机', '平板', '笔记本', '电视', '冰箱', '洗衣机', '空调', '扫地机',
  '咖啡机', '吸尘器', '投影仪', '显示器', '键盘', '鼠标', '显卡', '音箱', '手表', '相机', '镜头', '路由', '充电宝']

// 聊天里常带着的口头前缀，不是商品名的一部分
const LEAD_WORDS = ['帮我看看', '帮我查查', '帮忙看看', '帮我', '帮忙', '看看', '查查', '查一下', '问一下', '我想买', '想买',
  '你觉得', '请问', '那个', '这个', '现在', '目前', '大概', '多少钱', '什么价', '价格', '一下', '这', '那']

export function extractProductName (text) {
  const body = String(text || '').replace(/<[^>]*>/g, ' ')
  // 型号里可能带连字符和大写字母串（WH-1000XM5），字母段放宽到 12 个字符
  for (const match of body.matchAll(/[\u4e00-\u9fff]{2,14}\s*[A-Za-z]{1,12}[\s-]*\d{1,5}[A-Za-z0-9-]*/g)) {
    let candidate = match[0].replace(/\s+/g, ' ').trim()
    // 去掉口头前缀：「帮我看看红米 K80 Pro」→「红米 K80 Pro」
    for (let changed = true; changed;) {
      changed = false
      for (const word of LEAD_WORDS) {
        if (candidate.startsWith(word) && candidate.length > word.length + 3) {
          candidate = candidate.slice(word.length).trim()
          changed = true
        }
      }
    }
    // 前半截必须是真品牌或品类词，否则不是商品名（「没有整机价 A1」不能算）
    const head = (candidate.match(/^[\u4e00-\u9fff]{2,14}/) || [''])[0]
    const squashed = squash(head)
    const known = Boolean(squashed) && (
      brandEquivalents(head) !== null ||
      CATEGORY_WORDS.some((word) => squashed.includes(word) || word.includes(squashed))
    )
    if (known) return candidate
  }
  return ''
}

/**
 * 只搜到配件时的放宽关键词：把查询拆成词，取最像型号的那个单独再搜一次。
 * 「拓竹 A1」→「a1」，「红米 K80 Pro」→「k80pro」。拆不出来就返回空串（不重搜）。
 */
export function broadenKeyword (query) {
  const parts = splitQuery(query)
  const model = parts.find((part) => /[a-z]/.test(part) && /[0-9]/.test(part))
  if (model) return model
  const numeric = parts.find((part) => /^[0-9]{2,}$/.test(part))
  return numeric || ''
}

/**
 * 从搜索结果里挑要监控的那个商品。
 * 返回 { kind: 'one', item } | { kind: 'many', options } | { kind: 'none', options }。
 * 「多个」和「没有」都带候选项，让用户在 QQ 里按编号选，而不是直接失败。
 */
export function pickCandidates (query, items, { threshold = 0.6, suggest = 5 } = {}) {
  const scored = (Array.isArray(items) ? items : [])
    .map((item) => ({ item, score: matchScore(query, item.title) }))
    .filter((x) => x.score > 0)
    .sort((a, b) => b.score - a.score || (a.item.price || Infinity) - (b.item.price || Infinity))
  const strong = scored.filter((x) => x.score >= threshold)
  const pool = strong.length ? strong : scored
  if (!pool.length) return { kind: 'none', options: [] }
  // 同一件商品（指纹相同）只留最便宜的那一条，别让同款的不同爆料互相顶掉
  const seen = new Set()
  const unique = []
  for (const row of pool) {
    const key = row.item.key || row.item.articleId || row.item.title
    if (seen.has(key)) continue
    seen.add(key)
    unique.push(row)
  }
  if (strong.length && unique.length === 1) return { kind: 'one', item: unique[0].item }
  // 强匹配只有一条、其余都是弱候选：仍然算唯一
  if (strong.length && unique.length > 1) {
    return { kind: 'many', options: unique.slice(0, suggest).map((x) => x.item) }
  }
  if (unique.length === 1) return { kind: 'one', item: unique[0].item }
  return { kind: 'none', options: unique.slice(0, suggest).map((x) => x.item) }
}

/**
 * 这次检查要不要提醒。
 * 只有两种情况提醒：价格明显下降，或创下本插件记录的最低价。
 * 返回 { alert: boolean, reasons: string[], drop: number, dropPercent: number }。
 */
export function evaluateAlert (record, currentPrice, opts = {}) {
  const dropPercent = Math.max(0, Number(opts.dropPercent === undefined ? 5 : opts.dropPercent) || 0)
  const dropAmount = Math.max(0, Number(opts.dropAmount === undefined ? 5 : opts.dropAmount) || 0)
  const reasons = []
  const price = Number(currentPrice)
  if (!Number.isFinite(price) || price <= 0) return { alert: false, reasons, drop: 0, dropPercent: null }
  const previous = record && Number(record.price)
  const lowest = record && Number(record.lowest)
  const hasPrevious = Number.isFinite(previous) && previous > 0
  let drop = 0
  let percent = null
  if (hasPrevious && previous > price) {
    drop = Math.round((previous - price) * 100) / 100
    percent = Math.round((drop / previous) * 1000) / 10
    const byAmount = dropAmount > 0 && drop >= dropAmount
    const byPercent = dropPercent > 0 && percent >= dropPercent
    if (byAmount || byPercent) reasons.push('降价')
  }
  // 只有确实记录过最低价、并且这次更低，才算「历史最低」。
  // 没有最低价记录时不当成新低：宁可少报，也不把一次小波动说成历史最低。
  const hasLowest = Number.isFinite(lowest) && lowest > 0
  if (hasLowest && price < lowest) reasons.push('历史最低')
  return { alert: reasons.length > 0, reasons, drop, dropPercent: percent }
}

/** 北京时间当天（用来判断提醒冷却是不是同一天）。 */
export function shanghaiDay (ts) {
  const n = Number(ts)
  if (!Number.isFinite(n)) return ''
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Shanghai' }).format(new Date(n))
}

/**
 * 本机价格记录按最近使用裁到上限（LRU）：超出时删掉最久没被 observe() 碰过的商品指纹。
 * 就地修改 records 并返回它，方便测试和 index.mjs 的加载/观测路径复用。
 */
export function pruneRecords (records, limit = 800) {
  if (!records || typeof records !== 'object') return {}
  const max = Math.max(1, Math.floor(Number(limit) || 800))
  const keys = Object.keys(records)
  if (keys.length <= max) return records
  const seenAt = (key) => {
    const row = records[key] || {}
    const stamp = Number(row.lastSeen)
    if (Number.isFinite(stamp) && stamp > 0) return stamp
    const low = Number(row.lowestAt)
    return Number.isFinite(low) && low > 0 ? low : 0
  }
  keys.sort((a, b) => seenAt(a) - seenAt(b))
  for (const key of keys.slice(0, keys.length - max)) delete records[key]
  return records
}

/** 失败退避的上限：6 小时。正常间隔本身比它长时保持正常间隔，不反向缩短。 */
export const FAIL_BACKOFF_MAX_MS = 6 * 60 * 60 * 1000

/**
 * 一条监控失败后的下次检查间隔：每次失败翻倍（interval × 2^k），最长 6 小时。
 * 失败次数由调用方落盘，这里只做纯计算。
 */
export function retryIntervalMs (intervalMinutes, failCount) {
  const base = Math.max(1, Number(intervalMinutes) || 60) * 60000
  const fails = Math.max(0, Math.min(20, Math.floor(Number(failCount) || 0)))
  return Math.min(base * Math.pow(2, fails), Math.max(base, FAIL_BACKOFF_MAX_MS))
}

/**
 * 这一轮该检查哪些监控：手动强制全部，定时只挑到期的；按 lastCheck 最旧的先来，
 * 失败过的按 retryIntervalMs 退避。only 精确取一条（手动按 id 检查）。
 */
export function dueWatches (watches, { now = Date.now(), intervalMinutes = 60, max = Infinity, only = null, force = false } = {}) {
  const list = (Array.isArray(watches) ? watches : []).filter((watch) => watch && watch.id)
  if (only) return list.filter((watch) => watch.id === only).slice(0, 1)
  const stamp = Number(now)
  const due = force ? list.slice() : list.filter((watch) => {
    const last = Number(watch.lastCheck) || 0
    if (!last) return true
    return stamp - last >= retryIntervalMs(intervalMinutes, watch.failCount) - 5000
  })
  due.sort((a, b) => (Number(a.lastCheck) || 0) - (Number(b.lastCheck) || 0))
  const cap = Number.isFinite(Number(max)) ? Math.max(1, Math.floor(Number(max))) : due.length
  return due.slice(0, cap)
}

export default { parsePrice, formatPrice, productKey, scoreRate, heatScore, qualityOf, matchScore, pickCandidates, evaluateAlert, shanghaiDay, pruneRecords, retryIntervalMs, dueWatches, FAIL_BACKOFF_MAX_MS }
