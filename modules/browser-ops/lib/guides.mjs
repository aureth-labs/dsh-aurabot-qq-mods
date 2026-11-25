// guides.mjs —— browser-ops 的指引提示词库（浏览器自动化「操作手册」层）
// 来源：本项目自写；结构仿 mods-fork/modules/phone/lib/guides.mjs（MIT，Aurabot），内容全部重写为网页场景。
// 作用：按浏览场景给执行浏览任务的决策器注入操作指引。总纲（main）不挂 URL/关键词、
//       永远不会被 resolve 自动挑中，只在「主动浏览任务」（浏览器任务书）时与场景手册
//       一起注入；场景手册（登录/搜索/读页/表单）按任务目标关键词按需加载，省 token。
// 契约：
//   BUILTIN_GUIDES：内置指引（key → { name, keywords, text }）
//   createGuides(dataDir) → { list(), get(key), upsert(key, {name,text}), remove(key), resolve({ goal, url }) }
// 自定义指引存 dataDir/guides/<key>.md，可覆盖同名内置项；首行 `<!-- name: xxx -->` 可改名。

import { readFileSync, writeFileSync, unlinkSync, existsSync, mkdirSync, readdirSync } from 'node:fs'
import { join } from 'node:path'

// ---------- 内置指引（总纲（主流程）→ 场景手册（总则 → 操作套路 → 坑）） ----------

// 主流程总纲：不挂任何 keywords（resolve 永远不会自动挑它），只在「主动浏览任务」
// 或主人显式指定时注入，描述这类任务整体怎么排、以什么为主；面板指引列表里独立卡可编辑。
const MAIN_GUIDE = `【总纲 · 主流程】
◆ 这份总纲是什么
- 它是「主动浏览任务」的章程：主人让逛网页、或其他模块经 api.use('browser-ops') 发起浏览任务时，
  这份总纲会常驻注入决策上下文；场景手册（登录/搜索/读页/表单）按当前任务目标按需追加，总纲优先。
- 本总纲不挂关键词，永远不会被自动挑中；只在这类「浏览任务」场合注入。
◆ 总则（任务怎么排）
- 一个任务 = 先读页拿快照 → 再按场景手册操作 → 每个关键动作后用新快照/截图验证，没变化就重试一次。
- 页面快照是决策的全部线索：元素列表与正文摘要就是「节点清单」，动作前必须对着它确认目标还在当前页。
- 快照与页面不一致（跳转/弹层挡住）：先重新拿一次快照再决策，别拿旧快照硬点。
◆ 互动尺度（安全红线）
- 主动浏览只做「只读 + 轻互动」：打开、滚动、读内容、按任务点明确指名的按钮。
- 发帖、评论、私信、支付、删除等一切写操作默认不做；主人任务里明确要求了才做。
- 遇到验证码、支付、实名、登录墙：立即停下并如实汇报卡在哪，绝不尝试绕过。
- 快照里出现「确认支付」「输入验证码」类元素而任务没要求：停手汇报，宁可少做不要硬撑。
◆ 收尾（怎么交代）
- 任务做完要说清：到了哪些页面、做了什么（读了几屏/点没点东西）、结果验证过没有。
- 中途被弹窗/验证码/白名单拦住的，也要如实说原因，别只报「完成」。`

const LOGIN_GUIDE = `【登录 · 场景手册】
◆ 总则（登录页长什么样）
- 登录页核心是：账号/手机号输入框、密码输入框、验证码区、登录按钮；第三方登录（微信/手机扫码）也常见。
- 登录资料目录是持久的：Cookie 还在时多数网站根本不会出现登录页——先 navigate 后看快照确认真的需要登录再动手。
◆ 操作套路（常用任务拆解）
- 账号密码登录：snapshot 找输入框 → click 输入框 → input 内容 → 逐个填完 → click 登录按钮 → 下一步快照验证（跳转/出现新元素）。
- 扫码登录：主人要在场——用 show(true) 把窗口挪进屏幕，请主人扫；等主人确认后再 show(false) 挪回屏幕外。
- 判断是否登录成功：快照里出现用户名/头像/「我的」入口，或地址栏离开了登录页。
◆ 坑（高频翻车点）
- 密码、验证码、短信码：绝不代输——要么主人在资料里登录过（Cookie 有效），要么停手请主人自己输。
- 登录页的「第三方登录」按钮常在页面底部或弹层里，快照被弹层盖住时先关弹层再找。
- 登录失败提示（密码错误/被风控）出现两次：停手汇报，别连续重试触发风控。`

const SEARCH_GUIDE = `【搜索 · 场景手册】
◆ 总则（搜索页长什么样）
- 搜索入口三种：首页顶部搜索框、独立搜索页（search 域名）、地址栏直达（https://www.bing.com/search?q=）。
- 结果页是标题+摘要+链接的列表；广告位混在里面，认「广告」标记，别拿广告当结果。
◆ 操作套路（常用任务拆解）
- 有搜索框：snapshot 找输入框 → click → input 关键词 → pressEnter（回车常等价点搜索）→ 等新快照。
- 没有搜索框或要精确：直接 navigate 到带 q= 参数的搜索地址（Bing/百度/Google 均支持），比点框输入更稳。
- 读结果：snapshot 的元素列表里标题即节点；要第 n 条就点标题文本匹配的那个元素，正文细节用 snapshot 的正文摘要读。
- 翻页/换词：结果不对就改关键词重搜，别在结果页里乱点「相关搜索」。
◆ 坑（高频翻车点）
- 搜索框联想下拉会盖住快照：input 后直接 pressEnter，别去找联想词。
- 「综合/视频/图片」分类 Tab 别乱切，默认综合即可。
- 搜索结果页的登录墙/APP 引导弹层优先关闭（找「×」「跳过」「暂不」），关不掉就换搜索引擎。`

const READ_GUIDE = `【读页 · 场景手册】
◆ 总则（读什么）
- 读页任务的产出是内容本身：标题、正文要点、表格数据、链接列表——优先用 snapshot 的正文摘要与元素文本。
- 长页面正文被摘要截断时：分段滚动（scroll dy 600~800）+ 每屏一次 snapshot，逐屏拼出全文要点。
◆ 操作套路（常用任务拆解）
- 打开即读：navigate → snapshot → 从正文摘要提炼；需要更精确就 evaluate 取指定元素的文本。
- 图片/表格读不清：screenshot 截图（可传 clip 只截目标区域），交给视觉模型看。
- 多页文章/列表：找「下一页」元素 click 后再 snapshot；没有分页元素就停，别猜地址翻页。
◆ 坑（高频翻车点）
- 快照正文里混着评论区/推荐流：认「正文/文章」区，别把推荐标题当正文。
- cookie 同意条/通知弹窗占半屏：先关（找「同意」「×」「仅必要」）再读。
- 页面是纯图片/视频（正文摘要空）：改用 screenshot + 视觉模型，别硬猜文本。`

const FORM_GUIDE = `【表单 · 场景手册】
◆ 总则（表单怎么处理）
- 表单元素三类：文本输入框、下拉/单选/复选、提交按钮；快照的元素列表会带 placeholder/value，就是填写线索。
- 表单是典型写操作：只有主人任务明确要求「填/提交」才动手，提交前必须核对一遍已填内容。
◆ 操作套路（常用任务拆解）
- 填写：逐项 click 输入框 → input 内容；下拉元素用 click 展开后从快照选项里点；复选框 click 切换。
- 提交：全部填完 → snapshot 核对 → click 提交按钮 → 下一步快照验证（成功提示/跳转）。
- 分步表单（向导）：每步填完点「下一步」，快照确认进了下一步再继续。
◆ 坑（高频翻车点）
- 必填项漏填导致提交无效：提交后快照仍停在表单且出现红色提示，说明哪项没填/填错，修完再提交，最多重试一次。
- 验证码输入框：绝不代填，停手汇报。
- 「提交」与「保存草稿」是两个按钮：认准任务要求的那个，别点错。`

// 通用模板：所有内置/自定义场景手册请按「总则 → 操作套路 → 坑」三段仿写。
const GENERIC_GUIDE = `【通用 · 操作手册（自定义指引请照此结构仿写）】
◆ 写给要自定义指引的人：仿写模板
- 新指引按本节的三段结构写：总则（页面怎么长）→ 操作套路（常用任务拆解）→ 坑（高频翻车点）；一段都别省。
- 只描述浏览器自动化操作（navigate/click/input/scroll/snapshot/screenshot），不确定的界面细节写「在快照里搜 XX 两个字」，别编造精确坐标。
- 每条套路尽量写成「入口 → 中间步骤 → 验证」三拍，验证写清下一步快照里该出现什么。
- 写操作（发帖/评论/支付/删除）必须标注「仅主人明确要求才做」，并写明停手条件。
◆ 总则（决策器视角的页面观）
- 一切决策只依据快照文本与截图：元素列表（标签+文本+链接）与正文摘要是全部线索。
- 可用动作：navigate（打开网址）、click（点元素/坐标）、input（输入）、clearInput、pressEnter、scroll、screenshot、snapshot、evaluate、show。
- 快照模式 dom 是默认（标题/元素/正文摘要），a11y 是无障碍树，读不清时换一种再试。
◆ 操作套路（通用流程骨架）
- 打开：navigate → snapshot；地址不对或被重定向，看快照顶部的「地址」行确认落在了哪。
- 找入口：先扫元素列表找文本精确匹配；没有就 scroll 下一屏再看。
- 输入：click 输入框 → input → pressEnter 或找「搜索/提交」元素 click。
- 等待：页面加载慢时，重新 snapshot 一次再决策，别拿旧快照硬点。
- 验证：关键动作执行后，下一步快照里应有变化（文案变了/新元素出现）；没变化视为失败，重试一次后如实汇报。
◆ 坑（通用安全与失败处理）
- 弹窗/广告/cookie 条优先关闭：找「×」「跳过」「我知道了」「以后再说」「仅必要」。
- 出现验证码、支付、人脸、登录墙：立即停手汇报，绝不尝试绕过。
- 同一动作连续两次无效（快照没变）：停止重试，换路径或如实汇报。
- 站点白名单非空时，白名单外的网址 navigate 会被拒绝——如实汇报，别试图绕道。`

export const BUILTIN_GUIDES = {
  main: { name: '总纲·主流程', keywords: [], text: MAIN_GUIDE },
  login: { name: '登录', keywords: ['登录', 'login', '扫码', '签到账号', '密码'], text: LOGIN_GUIDE },
  search: { name: '搜索', keywords: ['搜索', '搜一下', '查一下', 'search', '百度', 'bing', '找资料'], text: SEARCH_GUIDE },
  read: { name: '读页', keywords: ['读', '看看', '浏览', '读一下', '总结', '文章', '新闻'], text: READ_GUIDE },
  form: { name: '表单', keywords: ['表单', '填写', '提交', '报名', 'form'], text: FORM_GUIDE },
  generic: { name: '通用', keywords: [], text: GENERIC_GUIDE },
}

/** 读自定义覆盖层：dataDir/guides/<key>.md 存在则 text 用它，首行 `<!-- name: xxx -->` 可改名。
 *  key 白名单：get/readCustom 也可能被外部值喂进来，`../../x` 之类越目录的 key 直接按「没有自定义层」处理。 */
function readCustom(dataDir, key) {
  if (!/^[A-Za-z0-9_-]{1,40}$/.test(String(key || ''))) return null
  const p = join(dataDir, 'guides', `${key}.md`)
  if (!existsSync(p)) return null
  let text = ''
  try { text = readFileSync(p, 'utf8') } catch { return null }
  let name = ''
  text = text.replace(/^<!--\s*name:\s*(.+?)\s*-->\s*\n/, (_, n) => { name = n.trim(); return '' })
  return { name, text }
}

function writeCustom(dataDir, key, { name, text }) {
  const dir = join(dataDir, 'guides')
  mkdirSync(dir, { recursive: true })
  const head = name ? `<!-- name: ${name} -->\n` : ''
  writeFileSync(join(dir, `${key}.md`), head + String(text || ''), 'utf8')
}

export function createGuides(dataDir) {
  return {
    /** 全部指引（内置 + 自定义覆盖后的形态），source 标明来源 */
    list() {
      const customKeys = existsSync(join(dataDir, 'guides'))
        ? readdirSync(join(dataDir, 'guides')).filter((f) => f.endsWith('.md')).map((f) => f.replace(/\.md$/, ''))
        : []
      const keys = [...new Set([...Object.keys(BUILTIN_GUIDES), ...customKeys])]
      return keys.map((key) => {
        const b = BUILTIN_GUIDES[key]
        const c = readCustom(dataDir, key)
        if (!b && c) return { key, name: c.name || key, source: 'custom', keywords: [], text: c.text }
        return { key, name: c?.name || b.name, source: c ? 'custom' : 'builtin', keywords: b?.keywords || [], text: c?.text || b.text }
      })
    },
    /** 取一条指引的正文（自定义优先）；generic 永远有 */
    get(key) {
      if (!key || key === 'generic') return BUILTIN_GUIDES.generic.text
      const c = readCustom(dataDir, key)
      if (c?.text) return c.text
      return BUILTIN_GUIDES[key]?.text || null
    },
    /** 新建/覆盖自定义指引（自定义层整体覆盖，删除即回到内置版） */
    upsert(key, { name, text } = {}) {
      if (!key || !/^[a-z0-9-]{2,40}$/.test(key)) throw new Error('指引 key 只能是小写字母/数字/短横线（2~40 字）')
      writeCustom(dataDir, key, { name, text })
      return { key, name: name || key, source: 'custom', keywords: [], text: String(text || '') }
    },
    /** 删自定义层（回到内置；内置条目删不掉）。key 直接拼路径，白名单拦越目录。 */
    remove(key) {
      const k = String(key || '')
      if (!/^[A-Za-z0-9_-]{1,40}$/.test(k)) return false
      const p = join(dataDir, 'guides', `${k}.md`)
      if (!existsSync(p)) return false
      unlinkSync(p)
      return true
    },
    /** 按任务目标关键词挑场景手册 key：explicit 显式指定 > 关键词匹配 > generic。
     *  main 不挂关键词，永远不会被自动挑中（只在主动浏览任务时与手册一起注入）。 */
    resolve({ goal = '', sceneGuide = '' } = {}) {
      if (sceneGuide) return sceneGuide
      const goalText = String(goal)
      for (const [key, g] of Object.entries(BUILTIN_GUIDES)) {
        if (key !== 'generic' && key !== 'main' && g.keywords.some((k) => goalText.toLowerCase().includes(k.toLowerCase()))) return key
      }
      return 'generic'
    },
  }
}
