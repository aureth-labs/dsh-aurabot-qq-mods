// 模块：关键词调 API 池（api-pool）
// 作用：只在「指定群」里，群友发某个关键词就自动调用设定好的接口，把返回结果发回群里。
//   · 纯机械触发：命中关键词即接管这条消息，调用 API 并回复，完全不经过模型 / 不费 token。
//   · 只在白名单群内生效（配置里的「生效群」），其他群一概不触发；黑名单里的人也一律不触发。
//   · 每条 API 独立：URL、请求参数、数据类型（文本/图片/视频/音频/混合）、解析表达式、
//     触发关键词（每条可选「完全匹配」/「正则匹配」）、启停开关。
//   · 生效范围是全局设置（不挂在单条 API 上）：生效群白名单 + 触发范围（所有人/仅主人）
//     + 触发人黑名单（按 QQ 号），统一对所有 API 生效，存于 pool.json 根级。
//   · 「API 库」可填一个密钥（默认空 = 不需要）：凡是选了该库的接口，请求时自动加
//     `Authorization: Bearer <密钥>`；密钥只存本机 pool.json，导出配置不会带出去。
//   · 「混合」类型：一条响应里既有文字又有图片/视频/音频直链时，按配置的「消息段」顺序
//     各段用自己的解析表达式取值，分成多条消息依次发回（文字段 api.reply、媒体段 sendSegments）。
//     文字段取到字典时用「回复模板」渲染，否则直接回该值；不使用全局「解析表达式」。
//   · 文本回复统一做「HTML → 纯文本」清洗：<br> 与块级结束标签转换行、剥掉 <strong>/<small>
//     等标签、解码 &nbsp;/&amp; 等实体。接口字段里夹的 HTML 不会原样发到群里（媒体直链不受影响）。
// 数据：全部存 api.dataDir()（apipool/pool.json），热重载不丢，模块目录不落运行数据。
// 接口：/pool 查、/save 存、/del 删、/test 测单条、/testAll 测全部（并更新「有效」标记）。
// 发送：文本用 api.reply；图片/视频/语音下载为 base64 后用 sendSegments 直发（跨网关最稳）。
// 变量：{qq}/{nickname}/{gid} 为触发者信息；{match}=本条关键词实际匹配到的文字、
//   {text}=触发消息完整文本，这两个「匹配内置变量」与关键词命名捕获一起放进 ctx.vars，
//   可在 URL / 参数值 / 回复模板 / 错误模板里直接引用（同名命名捕获优先覆盖内置）。

import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { homedir } from 'node:os'

const MAX_TEXT = 2000 // 文本回复最长字数（超出截断）
const MAX_MEDIA = 25 * 1024 * 1024 // 图片/视频/音频下载上限（25MB）
const FETCH_MS = 30000 // 单次请求超时

const TYPE_LABEL = { text: '文本', image: '图片', video: '视频', audio: '音频', mixed: '混合' }
const SEG_TYPE = { image: 'image', video: 'video', audio: 'record' } // audio→record 就是语音

// ---- 池配置读写 ----
function poolFile(api) { return join(api.dataDir('apipool'), 'pool.json') }
function loadPool(api) {
  let cfg
  try { cfg = JSON.parse(readFileSync(poolFile(api), 'utf8')) } catch { cfg = {} }
  if (!Array.isArray(cfg.groups)) cfg.groups = []
  cfg.scope = cfg.scope === 'owner' ? 'owner' : 'everyone'
  if (!Array.isArray(cfg.blacklist)) cfg.blacklist = []
  cfg.blacklist = cfg.blacklist.map((q) => String(q).trim()).filter(Boolean)
  if (!Array.isArray(cfg.apis)) cfg.apis = []
  if (!Array.isArray(cfg.libraries)) cfg.libraries = []
  // 库密钥：旧配置没有 key 字段就补空串（默认不需要密钥，行为不变）
  cfg.libraries = cfg.libraries.map((l) => ({ ...l, key: String(l?.key ?? '').trim() }))
  return cfg
}
function savePool(api, cfg) {
  try { mkdirSync(api.dataDir('apipool'), { recursive: true }); writeFileSync(poolFile(api), JSON.stringify(cfg, null, 2), 'utf8') } catch {}
}
/** 单个库对外（面板）视图：库密钥「只写」——不把明文发到浏览器，只回一个 hasKey 标记。 */
function publicLib(l) {
  const { key, ...rest } = l || {}
  return { ...rest, hasKey: !!key }
}
/** 给面板读的池配置：库列表一律走 publicLib，密钥明文不出本机。 */
function publicPool(api) {
  const cfg = loadPool(api)
  return { ...cfg, libraries: (cfg.libraries || []).map(publicLib) }
}

// 系统「下载」目录：优先用 api 提供的下载目录能力（若有），否则回退到系统约定路径
function downloadDir(api) {
  try {
    if (typeof api.downloadDir === 'function') { const d = api.downloadDir(); if (d) return d }
    if (typeof api.resolveDownloadDir === 'function') { const d = api.resolveDownloadDir(); if (d) return d }
  } catch {}
  try { return join(homedir(), 'Downloads') } catch { return process.cwd() }
}
// 导出文件的完整路径：系统下载目录 + 带时间戳文件名
function exportFilePath(api) {
  const d = new Date()
  const pad = (n) => String(n).padStart(2, '0')
  const stamp = `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}${String(d.getMilliseconds()).padStart(3, '0')}`
  return join(downloadDir(api), `api-pool-${stamp}.json`)
}

// ---- 关键词匹配 ----
// 每行关键词形状：{ value: '关键词', mode: 'exact' | 'regex' }，逐条按顺序试，命中即返回。
//   · exact「完全匹配」（面板新增行的默认值）：整条消息 trim 后与关键词字面相等才算命中，
//     不做子串搜索、不解析正则。{match} = 关键词本身（也就是整条消息），groups 为空。
//   · regex「正则匹配」：保持旧版行为，两种形态都支持 ——
//       1) 普通正则 `王者语音` / `座$` / `(?<xz>\S+座)$` —— 用 RegExp 在任意位置找（子串匹配），
//          命名捕获组 `(?<city>...)` 命中的值会作为变量 {city} 可用；
//       2) 捕获模板：含 `{变量名}` 占位符，如 `王者语音{hero}` —— 占位符变命名捕获组、
//          其余字面匹配，首尾锚定 ^...$，命中后 {hero} 即可在参数/URL/模板里用。
//     正则写错时退回纯包含匹配（text.includes），仍是子串匹配。
// 兼容：旧配置里的纯字符串关键词（导出文件 / 老 pool.json）视为 regex，行为不变、不破坏正则与捕获模板；
//   面板里把这个下拉切到「完全匹配」即可改掉子串匹配。
// 返回值：null 未命中；否则 { hit, groups, match }：
//   · groups 为命名变量 obj（无捕获时为空对象）
//   · match 为实际匹配到的文字（regex 下是 m[0]；exact 下是整条消息）。
//     调用方把它作为内置变量 {match} 注入 ctx.vars，解决「座$ 只匹配到末尾、值传不上去」的问题。
function normalizeKeywords(keywords) {
  const list = Array.isArray(keywords) ? keywords : []
  const out = []
  for (const raw of list) {
    if (raw && typeof raw === 'object' && !Array.isArray(raw)) {
      const value = String(raw.value ?? '').trim()
      if (!value) continue
      // 带 mode 的新格式：exact 精确、其余（含缺 mode / regex 旧值）按正则，避免把旧正则误变字面量
      out.push({ value, mode: raw.mode === 'exact' ? 'exact' : 'regex' })
    } else {
      const value = String(raw ?? '').trim()
      if (!value) continue
      out.push({ value, mode: 'regex' }) // 旧纯字符串 → 正则（保持旧行为）
    }
  }
  return out
}
function matchKeywords(keywords, text) {
  for (const kw of normalizeKeywords(keywords)) {
    const s = kw.value
    if (kw.mode === 'exact') {
      if (text === s) return { hit: true, groups: {}, match: s }
      continue
    }
    try {
      const re = keywordToRegExp(s)
      const m = re.exec(text)
      if (m) {
        const groups = { ...(m.groups || {}) }
        // 去除空串捕获并统一 trim，便于判空与参数使用
        for (const k of Object.keys(groups)) {
          const gv = typeof groups[k] === 'string' ? groups[k].trim() : groups[k]
          if (gv === '' || gv == null) delete groups[k]; else groups[k] = gv
        }
        return { hit: true, groups, match: m[0] }
      }
    } catch { if (text.includes(s)) return { hit: true, groups: {}, match: s } } // 正则写错时退回纯包含
  }
  return null
}
function keywordToRegExp(s) {
  const hasPlaceholder = /{[A-Za-z_][A-Za-z0-9_]*}/.test(s)
  if (hasPlaceholder) {
    // 捕获模板：{name} → 命名捕获组（尽量取空也可以命中），其余字面转义，整体锚定首尾
    const parts = s.split(/({[A-Za-z_][A-Za-z0-9_]*})/)
    let re = '^'
    for (const p of parts) {
      if (/^{[A-Za-z_][A-Za-z0-9_]*}$/.test(p)) re += '(?<' + p.slice(1, -1) + '>.*?)'
      else re += escapeRegExp(p)
    }
    re += '$'
    return new RegExp(re)
  }
  return new RegExp(s) // 普通正则（可含命名组）
}
function escapeRegExp(x) { return String(x).replace(/[.*+?^${}()|[\]\\]/g, '\\$&') }

// ---- 按点号路径取值：$.data.reply / data.reply / $ / root ----
// 数组自动解包：遇到数组且下一段不是纯数字下标时，先在数组元素里找第一个含该段的对象，
// 再继续往下取。让 `[{shenhuifu:...}]` 这类「数组根」JSON 也能用 $.shenhuifu / shenhuifu
// 这种自然路径（不必写 $.0.shenhuifu）；但 $.0.shenhuifu 这种显式下标仍按原样精确取。
function getPath(obj, expr) {
  let path = String(expr || '').trim().replace(/^\$\.?/, '').replace(/^\./, '')
  if (!path || path === '$' || path === 'root') return obj
  let cur = obj
  const segs = path.split('.')
  for (let i = 0; i < segs.length; i++) {
    if (cur == null) return undefined
    const seg = segs[i]
    if (Array.isArray(cur) && !/^\d+$/.test(seg)) {
      let found
      for (const el of cur) {
        if (el && typeof el === 'object') {
          const v = getPath(el, segs.slice(i).join('.'))
          if (v !== undefined && v !== null && v !== '') { found = v; break }
        }
      }
      return found // 数组里没一个元素有这个字段 → undefined（不再往下走）
    }
    cur = cur[seg]
  }
  return cur
}
function parseJson(text) { try { return JSON.parse(text) } catch { return null } }

/** 「混合」类型的消息段：{ type, value }。
 *  · 每段 value 都是一个「解析表达式」（点号路径）；混合类型不读全局「解析表达式」。
 *  · text 段：取到字典（{}）且配了全局「回复模板」时，用模板渲染该字典；否则直接回该取值。
 *  · 媒体段：从取到的值里挖直链（$ / root 表示扫整个返回）。
 * 丢掉没填 value 的空白行，避免编辑器空行被当成一段发出去。 */
function normalizeParts(parts) {
  const TYPES = ['text', 'image', 'video', 'audio']
  return (Array.isArray(parts) ? parts : []).map((p) => ({
    type: TYPES.includes(p?.type) ? p.type : 'text',
    value: String(p?.value ?? '').trim(),
  })).filter((p) => p.value)
}

/** 解析表达式：按顺序取第一个非空的结果。 */
function extract(exprs, textBody) {
  const json = parseJson(textBody)
  const list = (Array.isArray(exprs) ? exprs : []).map((s) => String(s || '').trim()).filter(Boolean)
  for (const e of list) {
    const v = getPath(json ? json : (e && (e === '$' || e === 'root')) ? textBody : undefined, e)
    if (v !== undefined && v !== null && v !== '') return { value: v, json }
  }
  return { value: textBody, json }
}

/** 从任意值里挖出第一个 http(s) 直链（媒体用）。 */
function findUrl(v) {
  const all = collectUrls(v)
  return all.length ? all[0] : ''
}

/** 收集所有 http(s) 直链；返回数组。用于媒体类型随机挑一条。 */
function collectUrls(v) {
  const out = []
  const walk = (x) => {
    if (typeof x === 'string') {
      if (/^https?:\/\//i.test(x)) out.push(x)
      else { const m = x.match(/https?:\/\/[^\s"'<>]+/i); if (m) out.push(m[0]) }
      return
    }
    if (Array.isArray(x)) { x.forEach(walk); return }
    if (x && typeof x === 'object') {
      for (const k of ['url', 'src', 'link', 'file', 'srcUrl', 'href', 'data']) {
        if (x[k] != null) walk(x[k])
      }
    }
  }
  walk(v)
  // 去重保序
  return [...new Set(out)]
}

/** 把提取到的值整成「给人看的文本」。 */
function toText(v) {
  if (typeof v === 'string') return v
  if (Array.isArray(v)) return v.map((x) => toText(x)).filter(Boolean).join(' / ')
  if (v && typeof v === 'object') try { return JSON.stringify(v, null, 2) } catch { return String(v) }
  return String(v ?? '')
}

/** 接口字段里夹的 HTML → 发给群友看的纯文本。QQ 是纯文本，不渲染 <strong>/<br> 这类标签，
 *  直接透传会把标签原样露出来。这里统一：
 *   · <br> / 块级结束标签 → 换行，<li> → 换行 + 项目符号，其余标签剥掉；
 *   · 常见实体（&nbsp;/&amp;/&#39; …）解码；
 *   · 没有标签/实体时原样返回（连 trim 都不做），避免误伤普通字符串；
 *   · 标签检测要求 < 后紧跟字母，所以 "a < b > c" / "x<5 y>3" 不会被当成 HTML 吃掉。 */
function htmlToText(v) {
  if (typeof v !== 'string') return v
  const hasTag = /<\/?[a-zA-Z]/.test(v)
  const hasEntity = /&(?:nbsp|amp|lt|gt|quot|apos|#\d+|#x[0-9a-f]+);?/i.test(v)
  if (!hasTag && !hasEntity) return v
  return v
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<li[^>]*>/gi, '\n• ')
    .replace(/<\/(?:p|div|li|h[1-6]|tr|td|section|blockquote|ul|ol)\s*>/gi, '\n')
    .replace(/<\/?[a-zA-Z][a-zA-Z0-9]*(?:\s[^>]*?)?\/?>/g, '')
    .replace(/&nbsp;?/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&quot;/gi, '"')
    .replace(/&apos;/gi, "'")
    .replace(/&#(\d+);/g, (_, n) => { try { return String.fromCodePoint(Number(n)) } catch { return _ } })
    .replace(/&#x([0-9a-f]+);/gi, (_, n) => { try { return String.fromCodePoint(parseInt(n, 16)) } catch { return _ } })
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
}

/** 查一个内置/捕获变量：{qq}/{nickname}/{gid} 以及 ctx.vars 里的 {match}/{text}/{命名捕获}。
 *  返回 undefined 表示不是变量（交给 JSON 路径处理）；字符串值（含空串）直接返回。
 *  与 substParam 逻辑保持一致，供 renderTemplate 的 JSON-path 阶段兜底。 */
function lookupVar(path, ctx) {
  const p = String(path || '').trim()
  if (p === 'qq') return ctx?.uid ?? ''
  if (p === 'nickname') return ctx?.nickname ?? ''
  if (p === 'gid') return ctx?.gid ?? ''
  const vars = (ctx && typeof ctx.vars === 'object' && ctx.vars) || {}
  if (Object.prototype.hasOwnProperty.call(vars, p)) return vars[p]
  return undefined
}
/** 回复模板：把 {点号路径} 替换成返回 JSON 里的对应值；找不到再退回内置/捕获变量；再跑一次 substParam。 */
function renderTemplate(tpl, root, rawText, ctx) {
  const rendered = String(tpl || '').replace(/\{([^}]+)\}/g, (m, pathExpr) => {
    const path = String(pathExpr || '').trim()
    let v = getPath(root && typeof root === 'object' ? root : undefined, path)
    if (v === undefined || v === null || v === '') v = getPath(parseJsonSafe(rawText), path)
    // JSON 路径找不到时，退回内置变量 / 关键词捕获变量（{qq}/{gid}/{match}/{text}/{hero}…）
    // 否则 {match} 这类变量会在本阶段被抹成 ''，导致成功回复模板里用不了内置变量。
    if (v === undefined || v === null || v === '') {
      const lv = lookupVar(path, ctx)
      if (lv !== undefined) return toText(lv)
      return '' // 真找不到就留空
    }
    return htmlToText(toText(v)) // 接口字段里夹的 HTML 标签转成纯文本再拼进模板
  })
  // 剩余未匹配的内置变量（{qq}/{nickname}/{gid}/{match}/{text}/{命名捕获}）替换
  return substParam(rendered, ctx)
}
function parseJsonSafe(text) { try { return JSON.parse(text) } catch { return null } }

/** 内置参数替换：{qq}=触发者QQ号、{nickname}=触发者昵称、{gid}=群号，以及
 *  {match}=匹配到的文字、{text}=完整消息、关键词命名捕获 {varName}。深替换 + 字符串内嵌替换。
 *  注意：{qq}/{nickname}/{gid} 是固定映射；{match}/{text}/{命名捕获} 都从 ctx.vars 取。 */
function substParam(v, ctx) {
  const c = {
    uid: String(ctx?.uid ?? ''), nickname: String(ctx?.nickname ?? ''), gid: String(ctx?.gid ?? ''),
  }
  const vars = (ctx && typeof ctx.vars === 'object' && ctx.vars) || {}
  const leaf = (x) => {
    if (typeof x === 'string') {
      let out = x
        .replace(/\{qq\}/g, c.uid)
        .replace(/\{nickname\}/g, c.nickname)
        .replace(/\{gid\}/g, c.gid)
      for (const k of Object.keys(vars)) out = out.replace(new RegExp('\\{' + k + '\\}', 'g'), String(vars[k] ?? ''))
      return out
    }
    return x
  }
  return substJson(v, leaf)
}
/** 对任意 JSON 值做叶子替换（数组递归，对象递归，字符串过 leaf）。 */
function substJson(v, leaf) {
  if (Array.isArray(v)) return v.map((x) => substJson(x, leaf))
  if (v && typeof v === 'object') {
    const o = {}
    for (const k of Object.keys(v)) o[k] = substJson(v[k], leaf)
    return o
  }
  return leaf(v)
}

/** 把一条 API 解析成完整可请求地址：若关联了「API 库」，则拼 库基地址 + 路径。 */
function resolveUrl(a, cfg) {
  if (a && a.libId) {
    const libs = (cfg && Array.isArray(cfg.libraries)) ? cfg.libraries : []
    const lib = libs.find((l) => l && l.id === a.libId)
    if (!lib) return ''
    const base = String(lib.base || '').replace(/\/+$/, '')
    const p = String(a.path || '').replace(/^\/+/, '')
    return base + (p ? '/' + p : '')
  }
  return String(a.url || '').trim()
}

/** 选了「API 库」时取该库的密钥（默认空串 = 不需要密钥）。库不存在也返回空串。 */
function libKey(a, cfg) {
  if (!a || !a.libId) return ''
  const libs = (cfg && Array.isArray(cfg.libraries)) ? cfg.libraries : []
  const lib = libs.find((l) => l && l.id === a.libId)
  return lib ? String(lib.key ?? '').trim() : ''
}

/** 实际请求配置（测单条 / 测全部 / 真触发共用）。返回结构化结果，不直接发消息。
 *  useDefaults=true（仅测试场景）：捕获变量缺失时用参数默认值兜底，便于把带变量的接口测通。
 *  useDefaults=false（真实触发）：捕获变量缺失就不兜底，接口很可能失败 → 走错误模板提示。 */
async function probe(api, a, ctx, cfg, useDefaults) {
  // 解析 API 库：选了库则用 库基地址 + 路径 拼出完整 URL
  const effUrl = resolveUrl(a, cfg)
  if (!effUrl) return { ok: false, message: 'URL 为空或所选 API 库不存在，请检查配置' }
  // 未捕获变量用参数默认值兜底：URL/参数里出现的 {varName} 若在 ctx.vars 缺失，
  // 就找参数行里值恰好是 {varName}（或含它）的那个默认值 d 补进去。
  // 便于测试带捕获变量的接口（测试语境没真实捕获，靠默认值发一次真实请求）。
  const fillDefaults = () => {
    const vars = {}
    for (const p of (Array.isArray(a.params) ? a.params : [])) {
      const key = String(p.k || '').trim()
      const val = String(p.v || '')
      const m = val.match(/\{([A-Za-z_][A-Za-z0-9_]*)\}/)
      if (key && m) vars[m[1]] = String(p.d ?? '')
    }
    return vars
  }
  const realVars = (ctx?.vars && typeof ctx.vars === 'object') ? ctx.vars : {}
  let fullCtx
  if (useDefaults) {
    const defaults = fillDefaults()
    const mergedVars = {}
    for (const k of Object.keys(defaults)) mergedVars[k] = realVars[k] != null && String(realVars[k] ?? '') !== '' ? realVars[k] : defaults[k]
    fullCtx = { ...(ctx || {}), vars: { ...(realVars), ...mergedVars } }
  } else {
    // 真实触发：不兜底默认值，捕获变量缺失时就保持 {varName} 原样送出（接口大概率失败 → 走错误模板）
    fullCtx = { ...(ctx || {}), vars: { ...(realVars) } }
  }
  const url0 = substParam(effUrl, fullCtx)
  if (!/^https?:\/\//i.test(url0)) return { ok: false, message: 'URL 要以 http(s):// 开头' }
  let url = url0
  const params = (Array.isArray(a.params) ? a.params : []).filter((p) => p && String(p.k || '').trim() && p.k !== '__k__')
  const method = String(a.method || 'GET').toUpperCase()
  const opts = { method, headers: {}, signal: AbortSignal.timeout(FETCH_MS) }
  // 选了「API 库」且库里填了密钥 → 自动带 Authorization: Bearer（默认空串则完全不带）。
  // 只加在本次接口请求上；后续下载媒体直链是别的 URL，不带密钥以免泄露。
  const key = libKey(a, cfg)
  if (key) opts.headers['Authorization'] = 'Bearer ' + key
  // 参数值替换；值为空时回退到「默认值」（若配置了）
  const effVal = (p) => {
    return (substParam(String(p.v ?? ''), fullCtx).trim()) || String(p.d ?? '').trim()
  }
  if (params.length) {
    const sp = new URLSearchParams()
    params.forEach((p) => sp.append(String(p.k).trim(), effVal(p)))
    if (method === 'POST') { opts.body = sp.toString(); opts.headers['content-type'] = 'application/x-www-form-urlencoded' }
    else { const u = new URL(url); params.forEach((p) => u.searchParams.set(String(p.k).trim(), effVal(p))); url = u.toString() }
  }
  const res = await fetch(url, opts)
  if (!res.ok) return { ok: false, message: `接口返回 HTTP ${res.status}` }
  const ctype = String(res.headers.get?.('content-type') || '').toLowerCase()
  const buf = Buffer.from(await res.arrayBuffer())
  const textBody = buf.toString('utf8')
  const type = String(a.type || 'text')

  // 场景A：接口本身就返回媒体字节（Content-Type 就是 image/video/audio）→ 直接用响应体，无需解析 URL。
  // 常见于 luck.php 这类「请求即得图」的接口。
  const directMedia = ctype.startsWith('image/') || ctype.startsWith('video/') || ctype.startsWith('audio/')
  if (type !== 'text' && type !== 'mixed' && directMedia) {
    if (buf.length > MAX_MEDIA) return { ok: false, message: `资源 ${(buf.length / 1024 / 1024).toFixed(1)}MB 超过 ${MAX_MEDIA / 1024 / 1024}MB 上限` }
    return { ok: true, type, mediaBytes: buf, mediaUrl: url, bytes: buf.length, message: `拿到了 ${TYPE_LABEL[type]}（${(buf.length / 1024).toFixed(0)}KB）` }
  }

  if (type === 'mixed') {
    // 「混合」：按面板配置的「消息段」顺序，各段用自己的「解析表达式」取值 → segments，dispatch 逐条发多条消息。
    //   · 不读全局「解析表达式」(a.parse)；每段 value 就是一个点号路径（$ / root = 整个返回）。
    //   · text 段：取到字典（{}）且配了全局「回复模板」→ 用模板渲染该字典；否则直接回该取值的文本。
    //   · 媒体段：从取值里挖直链；任何媒体段都不走回复模板。
    const root = parseJsonSafe(textBody)
    const tpl = String(a.template || '').trim()
    const segments = []
    const notes = []
    for (const p of normalizeParts(a.parts)) {
      const expr = (p.value === '$' || p.value === 'root') ? '' : p.value
      const v = expr ? getPath(root, expr) : root
      if (p.type === 'text') {
        const isDict = v && typeof v === 'object' && !Array.isArray(v)
        const raw = isDict && tpl
          ? renderTemplate(tpl, v, textBody, fullCtx)
          : substParam(toText(htmlToText(v) ?? ''), fullCtx) // 非字典直接回取值（先清 HTML），仍替换内置变量
        const t = String(raw).trim()
        if (t) segments.push({ type: 'text', text: t.length > MAX_TEXT ? t.slice(0, MAX_TEXT) + '…' : t })
        else notes.push(`某文字段取值为空（${p.value}）`)
        continue
      }
      let urls = collectUrls(v)
      if (!urls.length) urls = collectUrls(root)
      if (!urls.length) urls = collectUrls(String(textBody).replace(/\\\//g, '/')) // JSON 里 \/ 转义的直链
      if (!urls.length) { notes.push(`${TYPE_LABEL[p.type] || p.type}段没挖到直链（${p.value}）`); continue }
      segments.push({ type: p.type, mediaUrl: urls[0] })
    }
    if (!segments.length) return { ok: false, message: `混合消息没有任何有效段${notes.length ? '：' + notes.join('；') : '（检查消息段配置）'}` }
    const summary = segments.map((s) => s.type === 'text' ? '文字' : (TYPE_LABEL[s.type] || s.type)).join(' + ')
    return { ok: true, type, segments, message: `混合 ${segments.length} 段（${summary}）${notes.length ? '；跳过：' + notes.join('；') : ''}`, sample: '' }
  }

  const { value, json } = extract(a.parse, textBody)

  if (type === 'text') {
    // 若配置了「回复模板」，按模板组拼；否则回单条解析结果
    const tpl = String(a.template || '').trim()
    if (tpl) {
      // 传 fullCtx：让 {match}/{text}/{命名捕获} 与 {qq}/{gid} 在回复模板里同样可用
      const rendered = renderTemplate(tpl, json || (parseJsonSafe(textBody)), textBody, fullCtx).trim()
      if (!rendered) return { ok: false, message: '模板渲染后为空（检查 {路径} 是否写对）' }
      return { ok: true, type, message: htmlToText(rendered), sample: rendered.slice(0, 200) }
    }
    const out = htmlToText(toText(value)).trim()
    if (!out) return { ok: false, message: '解析后为空（检查解析表达式）' }
    return { ok: true, type, message: out, sample: out.slice(0, 200) }
  }
  // 媒体：尽量取用户解析到的值里挖直链；若有多个 URL（如语音多条），随机挑一个
  const urls = collectUrls(value)
  if (!urls.length) { const t = collectUrls(textBody || findUrl(textBody)); if (t.length) urls.push(...t) }
  let mediaUrl = urls.length ? urls[Math.floor(Math.random() * urls.length)] : ''
  if (!mediaUrl) return { ok: false, message: '没从返回里挖到图片/视频/音频直链（检查解析表达式）' }
  const mres = await fetch(mediaUrl, { signal: AbortSignal.timeout(FETCH_MS) })
  if (!mres.ok) return { ok: false, message: `资源下载 HTTP ${mres.status}` }
  const mbuf = Buffer.from(await mres.arrayBuffer())
  if (mbuf.length > MAX_MEDIA) return { ok: false, message: `资源 ${(mbuf.length / 1024 / 1024).toFixed(1)}MB 超过 ${MAX_MEDIA / 1024 / 1024}MB 上限` }
  return { ok: true, type, mediaUrl, bytes: mbuf.length, message: `拿到了 ${TYPE_LABEL[type]}（${(mbuf.length / 1024).toFixed(0)}KB）` }
}

export default {
  id: 'api-pool',
  name: '关键词调 API 池',
  version: '1.6.0',
  api: 1,
  description: '只在指定群里，群友发某个关键词就自动调用设定好的接口，把返回的文本/图片/视频/音频直接发回群里。纯机械触发，不经过模型、不费 token。',
  panel: 'panel.js',
  capabilities: ['network', 'filesystem', 'plugin-internals'], // 调接口 + 落盘存池配置 + 面板路由取请求体
  setup(api) {
    const log = (...a) => { try { api.log.info?.('[API池]', ...a) } catch {} }

    // ---- 指定群里命中关键词 → 机械接管、调接口、回复 ----
    api.on('message', async (msg) => {
      try {
        if (msg.kind !== 'group') return false // 只管群聊
        const cfg = loadPool(api)
        const groups = (cfg.groups || []).map((g) => String(g).replace(/^group:/, '').trim()).filter(Boolean)
        const gid = String(msg.groupId ?? '').replace(/^group:/, '')
        if (!gid || !groups.includes(gid)) return false // 只在白名单群生效
        // 触发人黑名单（全局）：命中一律不触发，对所有人（含主人）生效，放在触发范围之前。
        const uid = String(msg.userId ?? '').trim()
        const blacklist = (cfg.blacklist || []).map((q) => String(q).trim()).filter(Boolean)
        if (uid && blacklist.includes(uid)) return false
        // 触发范围（全局）：仅主人时，非主人发什么都不触发。
        if (cfg.scope === 'owner' && !(api.isOwner?.(msg.userId) ?? false)) return false
        const text = String(msg.text || '').trim()
        if (!text) return false
        const apis = (cfg.apis || []).filter((a) => a.enabled !== false)
        for (const a of apis) {
          const m = matchKeywords(a.keywords, text)
          if (!m) continue
          // 内置匹配变量：{match}=本条关键词实际匹配到的文字、{text}=完整消息。
          // 与命名捕获合并（命名捕获同名优先覆盖内置），一起作为 ctx.vars 供参数/URL/模板使用。
          const builtins = { match: m.match ?? '', text }
          const vars = { ...builtins, ...(m.groups || {}) }
          await dispatch(api, a, msg, gid, log, vars)
          return true // 接管：不再交给她，省 token
        }
        return false
      } catch (e) {
        log('消息处理异常：', e.message)
        return false
      }
    })

    // ---- 面板接口 ----
    api.route('/pool', async () => ({ ok: true, pool: publicPool(api) }))
    api.route('/save', async (req) => {
      const body = await api.core.http.body(req).catch(() => ({}))
      const cfg = loadPool(api)
      const a = body.api
      if (!a) return { ok: false, message: '缺 api 字段' }
      const apis = cfg.apis || []
      const name = String(a.name || '').trim()
      if (!name) return { ok: false, message: '名称不能为空' }
      const clean = normalizeApi(a)
      if (a.id && apis.some((x) => x.id === a.id)) {
        cfg.apis = apis.map((x) => (x.id === a.id ? { ...x, ...clean, id: a.id } : x))
      } else {
        clean.id = (a.id && a.id !== 'new') ? a.id : `a${Date.now()}` + Math.floor(Math.random() * 1000)
        cfg.apis = [clean, ...apis]
      }
      savePool(api, cfg)
      return { ok: true, message: `已保存「${name}」` }
    })
    api.route('/del', async (req) => {
      const body = await api.core.http.body(req).catch(() => ({}))
      const cfg = loadPool(api)
      cfg.apis = (cfg.apis || []).filter((x) => x.id !== body.id)
      savePool(api, cfg)
      return { ok: true, message: '已删除' }
    })
    // 生效设置（全局）：一次保存生效群白名单 + 触发范围 + 触发人黑名单，对所有 API 统一生效。
    // 保留旧路由名 /groups 以兼容旧面板；另注册 /settings 语义更清楚。
    const saveSettings = async (req) => {
      const body = await api.core.http.body(req).catch(() => ({}))
      const cfg = loadPool(api)
      if (Array.isArray(body.groups)) {
        cfg.groups = body.groups.map((g) => String(g).replace(/^group:/, '').trim()).filter(Boolean)
      }
      if (body.scope === 'owner' || body.scope === 'everyone') cfg.scope = body.scope
      if (Array.isArray(body.blacklist)) {
        cfg.blacklist = body.blacklist.map((q) => String(q).trim()).filter(Boolean)
      }
      savePool(api, cfg)
      return { ok: true, groups: cfg.groups, scope: cfg.scope, blacklist: cfg.blacklist }
    }
    api.route('/groups', saveSettings)
    api.route('/settings', saveSettings)
    api.route('/libs', async () => ({ ok: true, libs: (publicPool(api).libraries || []) }))
    api.route('/libSave', async (req) => {
      const body = await api.core.http.body(req).catch(() => ({}))
      const cfg = loadPool(api)
      const libs = cfg.libraries || (cfg.libraries = [])
      const name = String(body.lib?.name || '').trim()
      const base = String(body.lib?.base || '').trim()
      const rawKey = String(body.lib?.key ?? '').trim()
      const clearKey = body.lib?.clearKey === true // 面板点「清除密钥」时显式清空
      if (!name) return { ok: false, message: '库名称不能为空' }
      if (!/^https?:\/\//i.test(base)) return { ok: false, message: '库地址要以 http(s):// 开头' }
      const id = String(body.lib?.id || '')
      if (id && libs.some((x) => x.id === id)) {
        // 面板看不到明文密钥：留空表示「不改」，故沿用旧值；只有 clearKey 才真的清空。
        const oldKey = String(libs.find((x) => x.id === id)?.key ?? '').trim()
        const key = clearKey ? '' : (rawKey || oldKey)
        cfg.libraries = libs.map((x) => (x.id === id ? { ...x, name, base, key } : x))
      } else {
        const nid = id || 'lib' + Date.now() + Math.floor(Math.random() * 1000)
        const key = clearKey ? '' : rawKey // 新建库：留空 = 不需要密钥
        cfg.libraries = [...libs, { id: nid, name, base, key }]
      }
      savePool(api, cfg)
      return { ok: true, message: `已保存库「${name}」`, libs: cfg.libraries.map(publicLib) }
    })
    api.route('/libDel', async (req) => {
      const body = await api.core.http.body(req).catch(() => ({}))
      const cfg = loadPool(api)
      cfg.libraries = (cfg.libraries || []).filter((x) => x.id !== body.id)
      savePool(api, cfg)
      return { ok: true, message: '已删除' }
    })
    api.route('/export', async () => {
      try {
        const cfg = loadPool(api)
        const file = exportFilePath(api)
        const payload = {
          meta: { type: 'api-pool-export', version: 1, exportedAt: new Date().toISOString() },
          groups: Object.keys(cfg.groups || {}).length || 0,
          // 只导出 id/name/base，绝不导出库密钥（key 只留在本机 pool.json，导入方自己填）
          libraries: (cfg.libraries || []).map((l) => ({ id: l.id, name: l.name, base: l.base })),
          apis: (cfg.apis || []).map((a) => normalizeApi(a)),
        }
        delete payload.groups // 生效群 / 触发范围 / 黑名单等本机设置都不跟随分享，导入方自己设
        mkdirSync(dirname(file), { recursive: true })
        writeFileSync(file, JSON.stringify(payload, null, 2), 'utf8')
        return { ok: true, message: `已导出到 ${file}`, path: file }
      } catch (e) { return { ok: false, message: '导出失败：' + e.message } }
    })
    api.route('/import', async (req) => {
      const body = await api.core.http.body(req).catch(() => ({}))
      const text = String(body?.data || '').trim()
      if (!text) return { ok: false, message: '请先选择一份 JSON 配置文件' }
      let parsed
      try { parsed = JSON.parse(text) } catch { return { ok: false, message: '格式不对：需要有效的 JSON' } }
      return importPayload(api, parsed)
    })
    api.route('/importUrl', async (req) => {
      const body = await api.core.http.body(req).catch(() => ({}))
      const url = String(body?.url || '').trim()
      if (!/^https?:\/\//i.test(url)) return { ok: false, message: '配置文件地址要以 http(s):// 开头' }
      let res, text
      try {
        res = await fetch(url, { signal: AbortSignal.timeout(FETCH_MS) })
        if (!res.ok) return { ok: false, message: `下载配置文件 HTTP ${res.status}` }
        text = await res.text()
      } catch (e) { return { ok: false, message: '下载配置文件失败：' + e.message } }
      let parsed
      try { parsed = JSON.parse(text) } catch { return { ok: false, message: '地址指向的不是有效 JSON 配置文件' } }
      return importPayload(api, parsed)
    })
    api.route('/test', async (req) => {
      const body = await api.core.http.body(req).catch(() => ({}))
      const cfg = loadPool(api)
      try {
        const r = await probe(api, body.api, { uid: '', nickname: '', gid: '' }, cfg, true)
        // 单条测试成功也刷新「有效」标记（能匹配到已存接口时）
        if (r.ok && body.api && body.api.id && body.api.id !== 'new') {
          const cfg = loadPool(api)
          cfg.apis = (cfg.apis || []).map((x) => (x.id === body.api.id ? { ...x, valid: true } : x))
          savePool(api, cfg)
        }
        return { ok: r.ok, message: r.ok ? r.message : `测试失败：${r.message}` }
      } catch (e) { return { ok: false, message: '测试失败：' + e.message } }
    })
    api.route('/testAll', async (req) => {
      const cfg = loadPool(api)
      const apis = (cfg.apis || []).filter((a) => a.enabled !== false)
      const results = []
      for (const a of apis) {
        try {
          const r = await probe(api, a, { uid: '', nickname: '', gid: '' }, cfg, true)
          a.valid = r.ok === true
          results.push({ id: a.id, name: a.name, ok: r.ok === true, message: r.ok ? '' : r.message })
        } catch (e) { a.valid = false; results.push({ id: a.id, name: a.name, ok: false, message: e.message }) }
      }
      savePool(api, cfg)
      return { ok: true, results, summary: `${results.filter((r) => r.ok).length}/${results.length} 正常` }
    })
  },
}

/** 规整一条 API：去掉多余字段、保默认值。 */
function normalizeApi(a) {
  const libId = String(a.libId || '').trim()
  const url = libId ? '' : String(a.url || '').trim()
  return {
    name: String(a.name || '').trim(),
    url,
    libId,
    path: String(a.path || '').trim(),
    method: String(a.method || 'GET').toUpperCase() === 'POST' ? 'POST' : 'GET',
    params: (a.params || []).map((p) => ({ k: String(p.k || '').trim(), v: String(p.v ?? ''), d: String(p.d ?? '') })).filter((p) => p.k),
    type: ['text', 'image', 'video', 'audio', 'mixed'].includes(a.type) ? a.type : 'text',
    parts: normalizeParts(a.parts),
    parse: (a.parse || []).map((p) => String(p || '').trim()).filter(Boolean),
    template: String(a.template || '').trim(),
    errorTpl: String(a.errorTpl || '').trim(),
    keywords: normalizeKeywords(a.keywords),
    enabled: a.enabled !== false,
    valid: a.valid === true,
  }
}

/** 把导出的 JSON（带 meta 或裸 {libraries, apis}）合并进当前池。返回 {ok, message}。 */
function importPayload(api, parsed) {
  const src = (parsed && parsed.meta && parsed.type === 'api-pool-export') ? parsed : parsed
  const cfg = loadPool(api)
  const hasLibs = Array.isArray(src.libraries)
  const hasApis = Array.isArray(src.apis)
  if (!hasLibs && !hasApis) return { ok: false, message: '内容里没有可导入的「API 库」或「API 池」数据' }
  const libs = cfg.libraries || (cfg.libraries = [])
  const apis = cfg.apis || (cfg.apis = [])
  let libCount = 0, apiCount = 0
  // 导入库：按 base 去重（同名/同基地址视为已有，跳过）
  if (hasLibs) {
    const known = new Set(libs.map((l) => l.base))
    for (const l of src.libraries) {
      const base = String(l?.base || '').trim()
      if (!base) continue
      if (known.has(base)) continue
      known.add(base)
      libs.push({ id: l.id || ('li' + Date.now() + Math.floor(Math.random() * 1000)), name: String(l.name || '站点'), base })
      libCount++
    }
  }
  // 导入 API：逐条 normalize，并重设 id（避免与本地冲突）
  const idSrc = new Set(cfg.apis.map((a) => a.id))
  if (hasApis) {
    for (const raw of src.apis) {
      const clean = normalizeApi(raw)
      if (!clean.name) continue
      let newId = clean.id
      if (!newId || idSrc.has(newId)) newId = `a${Date.now()}` + Math.floor(Math.random() * 1000)
      idSrc.add(newId)
      apis.push({ ...clean, id: newId })
      apiCount++
    }
  }
  savePool(api, cfg)
  return { ok: true, message: `导入成功${libCount ? `：新增 ${libCount} 个库` : ''}${apiCount ? `${libCount ? '、' : '：'}新增 ${apiCount} 条 API` : ''}${(!libCount && !apiCount) ? '（都是重复的，没新增）' : ''}` }
}

/** 按「错误模板」回一条，否则给通用提示。 */
async function replyError(api, msg, a, vars, gid, message) {
  const et = String(a.errorTpl || '').trim()
  if (et) {
    const out = renderTemplate(et,
      { error: message },
      JSON.stringify({ error: message, ...(vars || {}) }),
      { ...(vars ? { vars } : {}), uid: msg.userId ?? '', nickname: msg.nickname ?? '', gid })
    await api.reply(msg, htmlToText(String(out).trim()) || '请求失败，请稍后再试')
  } else {
    await api.reply(msg, htmlToText(`「${a.name}」出错了：${message}`))
  }
}

/** 取「正则匹配」关键词里的全部捕获变量名（{varName} 占位符）；完全匹配的行按字面处理，不算捕获。 */
function keywordVars(keywords) {
  const set = new Set()
  for (const kw of normalizeKeywords(keywords)) {
    if (kw.mode !== 'regex') continue
    const re = /\{([A-Za-z_][A-Za-z0-9_]*)\}/g
    let m
    while ((m = re.exec(kw.value))) set.add(m[1])
  }
  return [...set]
}

/** 下载一个媒体 URL 并发一段（图片/视频/语音）。返回是否成功。 */
async function sendOneMedia(api, chatId, seg, name) {
  const type = seg.type
  let buf = seg.mediaBytes
  if (!buf) {
    const mres = await fetch(seg.mediaUrl, { signal: AbortSignal.timeout(FETCH_MS) })
    if (!mres.ok) return false
    buf = Buffer.from(await mres.arrayBuffer())
  }
  if (buf.length > MAX_MEDIA) return false
  const b64 = buf.toString('base64')
  await api.sendSegments(chatId, [{ type: SEG_TYPE[type] || 'image', data: { file: 'base64://' + b64 } }], `「${name}」`)
  return true
}

/** 真触发：拿到结果并发回群里。vars 为 ctx.vars，含 {match}/{text} 内置变量与命名捕获。 */
async function dispatch(api, a, msg, gid, log, vars) {
  const chatId = msg.chatId || `group:${gid}`
  try {
    // 关键词里的捕获变量必须都有值：群友只发关键词没带内容（如只发「举牌」）时，
    // 不去请求接口，直接把空捕获当错误处理 → 回错误模板。
    const needVars = keywordVars(a.keywords)
    const emptyOnes = needVars.filter((k) => vars[k] == null || String(vars[k]).trim() === '')
    if (emptyOnes.length) {
      log(`群 ${gid} 触发「${a.name}」但捕获变量为空（${emptyOnes.join(',')}），跳过接口`)
      await replyError(api, msg, a, vars, gid, `缺少内容：请带上${emptyOnes.map((k) => `{${k}}`).join('、')}`)
      return
    }
    const r = await probe(api, a, { uid: msg.userId ?? '', nickname: msg.nickname ?? '', gid, vars }, loadPool(api), false)
    if (!r.ok) {
      await replyError(api, msg, a, vars, gid, r.message)
      return
    }
    if (a.type === 'text') {
      await api.reply(msg, r.message.length > MAX_TEXT ? r.message.slice(0, MAX_TEXT) + '…' : r.message)
      return
    }
    if (Array.isArray(r.segments)) {
      // 「混合」：按消息段顺序，分成多条消息依次发（文本走 reply、媒体走 sendSegments）。
      // 单段失败只记日志、继续发后面的，别因为一张图挂了把整条签文吞掉。
      for (const seg of r.segments) {
        try {
          if (seg.type === 'text') await api.reply(msg, seg.text)
          else if (!(await sendOneMedia(api, chatId, seg, a.name))) log(`「${a.name}」某媒体段下载失败，已跳过`)
        } catch (e) { log(`「${a.name}」某段发送失败：`, e.message) }
      }
      log(`群 ${gid} 触发「${a.name}」→ 发混合 ${r.segments.length} 段`)
      return
    }
    // 媒体：优先用接口直接返回的字节（direct），否则下载媒体 URL 转 base64
    const ok = await sendOneMedia(api, chatId, { type: a.type, mediaUrl: r.mediaUrl, mediaBytes: r.mediaBytes }, a.name)
    if (!ok) { await replyError(api, msg, a, vars, gid, '资源下载失败或资源过大'); return }
    log(`群 ${gid} 触发「${a.name}」→ 发${TYPE_LABEL[a.type]}`)
  } catch (e) {
    log(`群 ${gid} 触发「${a.name}」失败：`, e.message)
    await replyError(api, msg, a, vars, gid, e.message).catch(() => {})
  }
}

// 具名导出：供单元测试直接引用纯函数 / 组装好的请求逻辑，无需起插件宿主。
// 不影响 export default（模块入口），发布打包会忽略 test/ 目录但保留这些具名导出。
export {
  normalizeKeywords, matchKeywords, keywordToRegExp, escapeRegExp, getPath, extract,
  findUrl, collectUrls, toText, renderTemplate, parseJsonSafe, lookupVar,
  substParam, substJson, resolveUrl, libKey, htmlToText, normalizeParts, probe, normalizeApi,
  importPayload, replyError, keywordVars, dispatch,
}