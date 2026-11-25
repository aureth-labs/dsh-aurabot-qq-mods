# xhs 模块实现契约 v1（2026-11-06，Team Lead 钉版）

> 三位成员都照这份契约写，接口名一个字都不能改。拿不准就读
> `modules/douyin/lib/{browser,site,duty}.mjs` 与 `modules/douyin/test/douyin.test.mjs` 的对应部位。
> 全仓库注释一律中文；模块源码目录禁写任何运行数据。

## 0. 路线（设计稿 docs/XHS-MODULE-DESIGN.md 已定）

- 专用浏览器（Edge/Chrome，独立资料目录）+ 网页登录态；**不做无头**。
- 小红书网页接口有 `x-s/x-t` 签名，**页面里裸 fetch 拿不到签名** —— 所以读数据走 **DOM 解析**，
  写操作走 **DOM 点按钮 + `waitResponse` 等接口回执**（回执不关心谁签的名）。绝不自造签名。
- `site` 层依赖的 browser 面 = douyin 版 browser.mjs 的返回面（open/connected/evaluate/goto/
  waitFor/click/press/type/clearFocused/pressEnter/waitResponse/screenshot/show/close），
  **新增 setFiles**（发帖传图）。

## 1. lib/browser.mjs（从 douyin 版改写，MIT 同许可，文件头注明来源）

- 整体照抄 douyin/lib/browser.mjs 的结构与实现（这一份已在本仓实测过），改这些：
  - 注释/报错文案「抖音」→「小红书」；`cancelled()` 报错文案改「小红书已关闭，请先打开小红书开关」。
  - `pickPage(targets)`：优先 `https://www.xiaohongshu.com`（正则 `/^https:\/\/[^/]*xiaohongshu\.com/`，creator 域 `creator.xiaohongshu.com` 也算），其余页面兜底；多余的小红书页关掉（照 douyin 的 extra 逻辑）。
  - `DevToolsActivePort` 里写的标记改 `/devtools/browser/xhs`。
  - **新增 `setFiles(selector, files)`**：
    `DOM.getDocument` → `DOM.querySelector(node, selector)` → `DOM.setFileInputFiles({ files: string[] , nodeId })`。
    先 `Runtime.evaluate` 把目标 input 滚进视图不需要；找不到节点返回 false。
  - 返回对象在 douyin 面（open/connected/evaluate/goto/waitFor/click/press/type/clearFocused/
    pressEnter/waitResponse/screenshot/show/close）末尾加 `setFiles`。
  - profile 目录由调用方传（`api.dataDir('xhs', 'edge-profile')`），本文件不写死路径。

## 2. lib/site.mjs（全新写，DOM + waitResponse）

常量：`HOME = 'https://www.xiaohongshu.com/'`；`CREATOR_PUBLISH = 'https://creator.xiaohongshu.com/publish/publish?source=official'`。

纯函数（导出，测试直接测）：
- `findNoteId(text)` → `{ noteId }` | `{ short }` | null。认：
  `xiaohongshu.com/(explore|discovery/item)/([0-9a-f]{24})`（24 位十六进制）、
  `xhslink.com/<短码>`（`https?://xhslink\.com/[A-Za-z0-9_-]+/?`）；
  裸 24 位十六进制也算 `{ noteId }`。
- `resolveShort(url, fetchImpl = fetch)`：照 douyin 的 resolveShort，跳转最多 5 跳，拿到 noteId 返回，否则 ''。
- `digestOf(note, comments = [])`：给她看的摘要文本（标题/作者/赞藏评数/正文节选/热评），格式仿 douyin digestOf。
- `parseComments(nodes)` 不需要（DOM 直接出结构）。

`createSite({ browser, log })` → 全部返回 `{ ok, ... }` 或抛带 `code` 的错（`'login'` 未登录、`'verify'` 要验证码、`'dm'`、`'publish'`）：

- `ensure()`：browser.open → 不在 `https://www.xiaohongshu.com` 域就 goto HOME → sleep(1500)。返回 `{ ok }` 或 open 的失败结果。
- `verify()`：页面上有可见验证码容器就返回原因文本，否则 ''。查（querySelector 任一）：
  `.captcha-container, [class*="captcha"], iframe[src*="captcha"], iframe[src*="verify"]`，
  尺寸 > 200×150 且可见才算。
- `self()`：登录状态与当前号。读 `window.__INITIAL_STATE__.user`：
  `loggedIn` 为 true 时取 `userInfo`（userId/nickname）；拿不到 state 就当未登录返回 null；
  抛错只在意外情况。返回 `{ userId, nickname }` 或 null。
- `feed()`：首页/探索页推荐流。已在 `xiaohongshu.com/explore` 或首页就不刷新，否则 goto `HOME + 'explore'`；
  等待 `section.note-item a[href]`（最多 12s）；解析每张卡：
  `a.cover` 的 `href`（`/explore/<id>` 或 `/discovery/item/<id>`）、卡内标题（`.title`，可空）、
  作者（`.author .name`）、封面图 `img` 的 src、 liked 标记（`.like-wrapper.active` 之类，拿不到就算了）。
  返回 `{ noteId, title, author, cover }[]`（最多 20 条，按 DOM 顺序去重）。
- `search(keyword)`：goto `HOME + 'search_result?keyword=' + encodeURIComponent(keyword)` → 同 feed 的解析。
- `openNote(id)`：goto `HOME + 'explore/' + id`；等 `#detail-title`（等不到再试 `.note-container`）；
  有 `verify()` 就抛 verify。
- `readNote(id)`：openNote → 从 DOM 收：
  `note = { noteId: id, title: #detail-title 文本, desc: #detail-desc 或 .note-text 文本(截 800),
    author: .author-wrapper 里的名字, likes/collects/comments: .interact-container 里
    like-wrapper/collect-wrapper/chat-wrapper(或 .total) 的 count 文本转数字,
    isVideo: 页面里有 video 标签 }`；
  热评：`.comment-item`（最多 8 条）→ `{ name: .author .name, text: .content .note-text, likes: .like .count }`。
  滚两屏再收（图片笔记评论懒加载）。返回 `{ note, comments }`。
- `like(id)` / `collect(id)`：openNote → 对应按钮 `.like-wrapper` / `.collect-wrapper`
  （先 `waitFor` 拿到）；已激活（class 含 `active`）返回 `{ ok, already: true }`；
  `waitResponse(/\/api\/sns\/web\/v1\/note\/(like|collect)/, 10000)` 先挂上 → press 按钮 →
  等回执：无回执抛错；`json.code !== 0 && json.success !== true` 抛错（文案带接口码）→ 成功 `{ ok: true }`。
- `comment(id, text)`：openNote → 等输入框 `#post-textarea`（contenteditable）→ focus →
  type(text) → 核对框内文字（innerText 去空白等于 text，不对就 clearFocused 重打，两次不对放弃）→
  `waitResponse(/\/api\/sns\/web\/v1\/comment\/post/, 12000)` → 点发送按钮
  `.send-btn`（disabled 就 pressEnter 兜底）→ 回执 code 0 / success true 才算成；
  失败时清空输入框再抛。返回 `{ ok: true, cid: 回执 data?.comment?.id || '' }`。
- `profileOf(link)`：认 `xiaohongshu.com/user/profile/([0-9a-f]{24})` 直接过；
  其他 http 链接 goto 后最多等 10s 看 location.href 落到 user/profile；没有就抛错。
  返回 `{ userId, nickname }`（昵称从页面 `.user-name` / `.info-right .name` 取，取不到空串）。
- 私信（best-effort，结构拿不准就诚实报错）：`dms(userId, { nickname })`：
  goto `HOME + 'messages'`（等 10s；等不到会话列表抛 `code:'dm'`，文案「网页版没找到私信入口」）。
  会话行 = 列表里包含对方昵称文本的可点行（按 nickname 匹配；nickname 空就抛 dm）。
  点开会话 → 读消息气泡：`.message-list`（或 `[class*=message]` 容器）内的条目，
  `{ id, mine, text, at }`（id 用元素序号+文本 hash 兜底，at 拿不到就 0）。
  `sendDm(text)`：当前会话输入框（contenteditable 或 textarea）→ 打字核对 → 点发送
  （`waitResponse(/web\/message|im\/|send_msg/, 8000)` 等不到就核对气泡里出现自己的话）→ 成功 `{ ok: true }`。
  这块**允许失败**：错误文案写清楚「小红书网页版私信结构变了，需要人工看看」，code 统一 `'dm'`。
- `loginShot()`：截二维码弹窗区域（`.login-container` / `[class*=login]` 可见块），没有就整页。
- `loginStart()`：ensure → self() 有值直接 `{ ok, loggedIn: true, me }`；否则找「登录」按钮
  （可见文本=登录，最小那个）press → 等 `[class*=login] img, [class*=login] canvas`（二维码）→
  `{ ok, loggedIn: false, shot }`。
- `loginPoll()`：浏览器没连 `{ ok, loggedIn: false, shot: '' }`；verify() 有值返回截图；
  self() 有值 `{ ok, loggedIn: true, me }`；否则截图。
- `publish({ title, desc, imagePaths })`（**只在 duty 明确批准后调**）：
  goto CREATOR_PUBLISH → 等「上传图文」tab（可见文本含 图文）并 press →
  `setFiles('input[type=file]', imagePaths)` → 等 `#title-textarea, input[placeholder*="标题"]` →
  title 填 ≤20 字、desc 填 `#post-textarea` → 核对两框文字 →
  `waitResponse(/post|publish/, 15000)` → press 发布按钮（`.publish-btn`，可见文本含 发布）→
  回执 code 0/success 才算成，否则清文案抛 `code:'publish'`。返回 `{ ok: true }`。
- 兜底导出 `screenshot()`、`show(v)`、`connected()`（转发 browser）。

## 3. lib/duty.mjs（从 douyin duty 改写；`createXhs` 替代 `createDouyin`）

依赖注入（照 douyin）：`{ getConfig, setOwnerConfirmed, think, sendOwnerQQ, pushToSession,
memory, log, site: injected, browser: injectedBrowser, now = Date.now, wait, isSilence }`。
`getConfig()` 返回**模块 settings 整体**（不是 g.xhs 子对象——社区模块用 defaults+settings，见 index 契约）。
`think(prompt, opts)` → 文本；`sendOwnerQQ(text, itemId, logTag)` → 真假（治理面在 index 里包好，
duty 不碰 api.proactive）。isSilence 由 index 传（来自 `__lib('chat/reply.js')`），duty 内不 import `__lib`。

settings 键（全平铺）：`enabled, dryRun, browserPath, perRun, dwellMin, dwellMax, maxWatchPerDay,
maxRunsPerDay, intervalHours, likeEnabled, collectEnabled, commentEnabled, shareEnabled, dmEnabled,
publishEnabled, capLike, capCollect, capComment, capShare, capPublish, minWriteGapSec, newAccountDays,
shareTo('qq'|'dm'|'both'), dmPollMinutes, ownerInput`。

状态文件 `dataDir('xhs.json')`，`version: 1`。在 douyin state 基础上：`seen` 存 noteId；
`collect` 计数；`sharedXhs`（站内分享过去重，可先留空数组不用）；`ownerConfirmed`（`{ input, userId,
nickname }`，只有 `setOwnerConfirmed` 能写）；`drafts: [{ id, title, desc, images: [], at, status:
'pending'|'published'|'rejected', noteId? }]`（持久化，确认流用）。

与 douyin 的差异（其余安全门逻辑 1:1 保留：caps 新号减半、writesLeft、blocked、doWrite、pauseAll、
verify→当天停手+QQ汇报+截图、STOP_RE）：
- 能力开关键换成上面的 `*Enabled`；NAME 加 `collect: '收藏', publish: '发帖'`。
- 分享主人：网页版站内分享笔记卡片不稳，v0.1 `shareTo` 只做 `qq`（`dm/both` 配置存在但 duty 里
  按 qq 处理并在 shareHint 里说明）；去重用 `s.shared`（QQ 侧 itemId 天然幂等）。
- 刷一轮 `run({ force, ownerAsked })`：site.feed → 逐篇 `readNote`（停留 dwell 随机、热评一起拿）→
  think 给 JSON decisions（feeling/like/collect/comment/share/remember，上限文案同 douyin）→
  写操作走 doWrite（like→site.like，collect→site.collect，comment→site.comment）→
  share 走 sendOwnerQQ（文本 + `noteLink(id)`）→ memory.addEvent / add 同 douyin。
- `watch(link)`：idOf（findNoteId + resolveShort）→ readNote → 摘要返回给聊天。
- `likeNote(link)` / `collectNote(link)` / `commentNote(link, text)`：照 douyin act()，走 doWrite。
- 主人私信 `checkOwnerDms(from)`：逻辑照 douyin（dmInit 首看只记、30 分钟窗、[去刷小红书] 触发词、
  最多 3 条、dmTries≤3、dm_uncertain 不整轮重试、noteVia/contextVia 走 memory）。
  只认 `ownerConfirmed` 且 `ownerConfirmed.input === settings.ownerInput`。
- 发帖草稿流（douyin 没有，新写）：
  - `saveDraft({ title, desc, images })`：publishEnabled 才行；title 截 20、desc 户 1000；
    images 必须已在 `dataDir('xhs')` 下（用 path.resolve 前缀校验，防乱传路径）；id 用
    `Date.now().toString(36)`；status 'pending' 入 s.drafts；返回 `{ ok, id }`。
  - `confirmDraft(id)`：找到 pending 草稿 → ready() → site.publish(...) → 成功改 status
    'published' + noteId（publish 返回里拿不到就空串）+ memory.addEvent + QQ 通知主人；失败保留 pending 并报错。
  - `rejectDraft(id)`：status 'rejected'。
  - `pendingDrafts()`：给面板/工具列 pending。
  - capPublish / minWriteGapSec / newAccountDays / dryRun 全部生效（dryRun 时 publish 不调，
    记日志 + 记 `dry:publish`）。
- `resultNote(r)` 文案抖音→小红书；`browse({ ownerAsked, report })` / `tick()` / `account(force)` /
  `loginStep(start)` / `showWindow(v)` / `state()` / `dispose()` 全照 douyin，键名对齐 settings。
- `tick()` 里 awake 时段读 `getConfig().speakUp` 前先判存在（`g.speakUp?.awakeFrom ?? 8` 等，
  社区模块的 settings 里没有 speakUp；缺省 8~23 点）。
- 导出：`createXhs` + `pickJson`（照 douyin）。

## 4. index.mjs / module.json / README / LICENSE（装配任务）

- module.json 已由 Lead 写好（id xhs, version 0.1.0, capabilities 五项）——**别改**。
- index.mjs 照 tophub 风格：`export default { id:'xhs', name:'刷小红书', version:'0.1.0', api:1,
  description 同 module.json, defaults: {...}, settings: [...], setup(api) {...} }`。
  - defaults = §3 settings 键的默认值（enabled/dryRun/browserPath 默认 ''，publishEnabled 默认 false，
    其余开关 true，caps: like20/collect10/comment3/share5/publish1，minWriteGapSec 90，
    newAccountDays 3，perRun 5，dwell 8~25，maxWatchPerDay 40，maxRunsPerDay 4，intervalHours 4，
    shareTo 'qq'，dmPollMinutes 7，ownerInput ''）。
  - settings 数组声明式生成面板（switch/number/text/select，中文 label+hint；开关注明默认值与风险）。
  - `api.__xhsTestHooks`：`{ browser, site, now, wait, isSilence, proactive }` 注入，测试不打真网络。
  - setup：`createXhs({ getConfig: api.settings, think: api.think, sendOwnerQQ（内含 dryRun 判断 +
    api.proactive.submit 治理面 + hub.sendText 兜底，itemId 传进来）, pushToSession: hub.pushToSession,
    memory: api.lazy('memory'), log: api.log, ...hooks })`；`api.every(60_000, tick)`；
    `api.onDispose(dispose)`。
  - 路由（模块相对）：`/state /account /login /login/status /window /run /dms /confirm-owner
    /drafts /draft/confirm /draft/reject`（后三个读 POST body 的 id）。
  - 工具（api.tool，全部经 `permAllow`：`__lib('chat/access.js').permOf(g,key)!=='off'`，
    try/catch 兜底 true；键 `xhsBrowse/xhsLike/xhsComment/xhsShareOwner/xhsDm/xhsPublish`）：
    `xhs_watch` / `xhs_recent` / `xhs_browse` / `xhs_like` / `xhs_collect` / `xhs_comment` /
    `xhs_send_dm`（target=主页链接或userId）/ `xhs_confirm_owner`（主人核对，input=主页链接）/
    `xhs_publish_draft`（title/desc/images → saveDraft，回复里注明「等主人确认」）/
    `xhs_draft_list` / `xhs_publish_confirm`（id，仅主人聊天可见可用）。
    工具 description 风格照 douyin（「有人让你…时用」「别说已经发了」）。
  - 测试参考 `modules/douyin/test/douyin.test.mjs` 的 fake api 面（对齐 `src/core/modules.js`
    的 makeApi），假 site 注入 hooks；覆盖：findNoteId/resolveShort/feed 解析、
    caps 与 dryRun、验证码停手、评论上限、草稿确认流（未确认绝不 publish）、dmInit 首看不回、
    ownerConfirmed 防篡改（改 ownerInput 后必须重新核对）。

## 5. 验收（Lead 汇总做，成员不用跑）

`npm run catalog && npm run check && npm run pack`（仓库根目录）+
`AURABOT_PLUGIN_DIR="…/repo" node --import ./scripts/plugin-env.mjs --test "modules/xhs/test/*.test.mjs"`。
