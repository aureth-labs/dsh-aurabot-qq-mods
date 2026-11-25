# xhs 契约增补 v2（2026-11-06，Team Lead 钉版；在 v1 契约之上只增不改，冲突处以本篇为准）

> 六件新功能：视觉看图 / 截图发主人（含验证码截图发QQ通道）/ 关键词巡游 / 真·@主人 / 站内分享笔记卡片 / 回复评论。
> 原则同 v1：读走 DOM、写走点按钮 + waitResponse；不自造签名；deviations 明说，不静默改契约。

## 6. site.mjs 增补（xhs-site 成员）

- `comment(id, text, { at } = {})`（签名扩展，向后兼容）：`at = { userId, nickname }` 时真·@——
  先打 `@nickname`，等 @ 候选弹层（`.mention` / `[class*=at]` 类容器，最多等 8s），
  用 React fiber 回溯（照 douyin site.mjs `mention()` 的 `__reactFiber$` 走法）按 userId 认人点选，
  再核对编辑器里出现提及节点（class 含 mention/at-user 等）；认不出/弹层没出 →
  **清空输入框并抛 `code:'mention'`，绝不发假 @**。无 at 时行为与 v1 完全一致。
- `share(id, who)`（新）：`who = { userId, nickname }`。openNote → 点分享按钮（`.share-wrapper` /
  可见文本「分享」的最小可见元素）→ 等分享面板 → 在「发给朋友」区按 fiber props 里的 userId 认行；
  最近联系人没有就用面板搜索框搜 nickname 再认 → 点该行的发送/分享 →
  `waitResponse(/web\/message|send_msg|\/api\/sns\/web\/v1\/im/, 12000)` 回执 200/code0 才算成。
  已分享过（按钮变「已发送」类）返回 `{ ok, already: true }`。找不到人抛 `code:'share'`（文案提示可能需互关）。
- `noteShot(id)`（新）：openNote → 等 `.note-container` → `browser.screenshot()` 整页（能定位笔记容器就截容器 clip）→
  返回 dataURL 字符串。
- `readNote(id)` 返回扩展：`note.cover`（第一张图的 src）、`note.images`（笔记正文图片 src 数组，最多 9 张）。
  DOM 取 `img[src*="sns-img"]` 一类；拿不到就空数组，不抛。
- `ownNotes()`（新）：self() 拿 userId → goto `HOME + 'user/profile/' + userId` → 解析该页笔记卡
  （同 feed 的卡片解析）→ `[{ noteId, title }]`（最多 20 条）。未登录抛 `code:'login'`。
- `commentsOfNote(id)`（新）：openNote → 展开/滚动评论区（滚 4 屏）→ 解析全部评论
  `[{ cid, userId, nickname, text }]`（cid 从元素 key/属性兜底用「序号+文本 hash」；userId 走 fiber props；
  最多 30 条）。子评论（展开「共 N 条回复」）本期不展开，只取一级。
- `replyComment(id, cid, text)`（新）：openNote → 在评论列表里按 cid 定位评论行（fiber props 的 comment.id
  优先，兜底文本匹配）→ 点该行的「回复」→ 输入框 focus → 打字核对 → 发送（同 comment 的回执判定）→
  `{ ok, cid }`。找不到目标评论抛错。
- 原 `dms/sendDm/publish/...` 一律不动。

## 7. 新文件 lib/vision.mjs + lib/shots.mjs（xhs-vision 成员）

- **shots.mjs**（照 repo/src/bili/shots.js 的结构改写）：
  - 库目录 `api.dataDir('shots')`（由 index 传入 shotsDir 绝对路径，本文件不写死）；
    index.json `{ items: [{ file, noteId, title, note, at }] }`；文件名 12 位 hex + `.jpg`；
    md5（`node:crypto`）去重；只留最近 maxKeep 张，超了删最旧文件+条目。
  - 导出：`saveShot({ dir, buf, noteId, title, note, maxKeep })` → item；`loadShots(dir)`；
    `pickShot(items, query)`（照 bili 的按字命中打分，纯函数）；`deleteShot(dir, file)`；
    `shotPath(dir, file)`。全部依赖可注入（fsImpl/hashImpl），纯函数能被 node:test 直测。
- **vision.mjs**（照 repo/src/bili/vision.js 的调用面）：
  - `downloadImage(url, fetchImpl = fetch)`：带 `Referer: https://www.xiaohongshu.com/` 和常见 UA 下载
    图片 → Buffer（小红书 CDN 不带 Referer 可能 403）。失败返回 null 不抛。
  - `describeNote({ dsh, cfg, note, images })`：`canSeeImages(dsh, cfg)` 为 false → 返回 ''（跳过，不抛）；
    否则 `askModel(dsh, { cfg, system, text, images: images.map(b=>({data: b.toString('base64'),
    mediaType:'image/jpeg'})), maxTokens: 800, temperature: 0.3 })`。
    system 照 bili 的口径（只写画面确实可见的东西，不猜不编，3~6 句中文）。
    `askModel/canSeeImages` 经 `__lib('core/llm.js')` 取（模块内 `globalThis.aurabot.lib`），
    但**两个函数都作为可注入 deps**：`describeNote({..., deps = { askModel, canSeeImages }})`，测试注入假的。
  - dsh 句柄由 index 传 `api.dsh` 进来，vision.mjs 不 import api。

## 8. duty.mjs 增补（xhs-duty 成员）

- **注入面扩展**：`createXhs({ ...原有一套, sendImageToOwner, shots, vision })`。
  `sendImageToOwner(b64png, caption, itemId)` → 真假（index 实现：治理面/hub.sendSegments 图片段，
  dryRun 短路）；`shots`/`vision` 是 lib/shots.mjs、lib/vision.mjs 的注入点（不传就 import 真实现，
  测试传假的）。pauseAll 的验证码截图改走 `sendImageToOwner(截图b64, '小红书要验证，页面截图', itemId)`
  （v1 偏差2的欠账就此还清；没注入该函数时退回落日志）。
- **新 settings 键**：`keywords`（string，textarea 多行，每行一个关键词；空=只刷推荐）、
  `visionEnabled`(false)、`shotChance`(0.3)、`atOwnerEnabled`(false)、`capAtOwner`(3)、
  `replyEnabled`(false)、`capReply`(5)、`replyPollMinutes`(30)、`shotLibrary`(30)。
- **关键词巡游**：state 加 `keywordIdx`。run() 每轮开工前：keywords 非空且
  `s.runs % 2 === 1`（隔轮交替）→ `site.search(keywords[s.keywordIdx % len])` 取这一轮的笔记列表
  （feed 逻辑不变），用后 `s.keywordIdx++`。搜索轮的记忆/decision/写操作与推荐轮完全同一条链路。
- **视觉看图**：browse 轮逐篇 readNote 后，若 `visionEnabled` 且 note.images/cover 有货：
  `downloadImage(cover 或第一张)` → `describeNote(...)` → 画面描述拼进 digestOf 之后喂 think
  （标注「画面：…」）；按 `shotChance` 概率把这次截图/下载的图存进截图库（`shots.saveShot`）。
  describe 出错/空串就当没看图，不阻断刷轮。整轮视觉开销最多 3 篇（防慢）。
- **真·@主人**：decision JSON 增加 `"at": true/false`；at 生效条件 =
  `atOwnerEnabled && ownerConfirmed && capAtOwner 剩量 && commentLeft`（照 douyin atLeft 的口径）；
  doWrite('comment') 时把 at 传给 site.comment；`code:'mention'` 的失败按普通失败记（不算风控不停手），
  但**去掉模型自己打的 @xxx 文本**这条 douyin 规则保留。
- **站内分享**：shareTo 现在真支持 `'dm'|'both'`：`site.share(noteId, ownerConfirmed)` +
  state 加 `sharedXhs` 去重表（300 条）；dm 失败照旧回落 QQ（shareToOwner 语义同 douyin）。
- **回复评论**：新方法 `replyComments(from)`：`replyEnabled && ownerConfirmed` 才动；
  ownNotes() → 逐篇 commentsOfNote → 用 `replySeen`（state，300 条）滤新评论 →
  挑最近 ≤6 条喂 think（给她看的口径：「这些是评论你笔记的人，要回谁、回什么，不回就空」，
  decisions `[{cid, reply}]`）→ 逐条 `site.replyComment`（走 doWrite('reply')：capReply、
  minWriteGapSec、dryRun、验证码停手全套生效）→ memory.addEvent + 汇报主人（QQ，每轮最多一条汇总）。
  tick() 里 `replyPollMinutes` 到点调一次（与刷轮/私信互斥：busy 检查）。
- `state()` 增补：`keywords 当前轮到哪个`、`atOwner/reply 余量`、`shots 库存数`（shots 库注入的话）。

## 9. index.mjs / panel.js / README / 测试 增补（xhs-app 成员）

- **新 defaults/settings**（§8 全部键的默认值 + 面板控件）：keywords 用 textarea；visionEnabled/
  atOwnerEnabled/replyEnabled 用 Switch（注明默认关）；shotChance 用 Range 0~1 step0.05；
  capAtOwner 0~10、capReply 0~20、replyPollMinutes 5~120、shotLibrary 5~100 用 Range。
- **sendImageToOwner 实现**：`hub.sendSegments(to, [{type:'image', data:{file:'base64://'+b64}}, …],
  caption)`（douyin 同款）；经 api.proactive 治理面时文本照旧、图片段直发（治理面不支持图片段就直发兜底，
  两种都失败回 false）。dryRun 时只 log。
- **新工具**（全部 owner-only 口径）：
  - `xhs_send_shot(query)`：从截图库挑一张（pickShot）→ hub.sendSegments 发当前聊天；
    「主人说发张截图/给我看看你刷到的」时用。
  - `xhs_shot_list`：列库存（来自哪个笔记、什么时候）。
  - `xhs_reply_comments`：「去看看评论/回一下评论」时调 duty.replyComments。
- **新路由**：`/shots`（列表）、`/shot/delete`（POST file）、`/replies/run`、`/vision/state`
  （visionEnabled + canSeeImages 结果，面板显示「她现在能不能看图」）。
- **panel.js 增补**：卡2 加 keywords textarea 与 vision/atOwner/reply 开关及滑块；
  卡1 状态总览加「看图」「@主人」「回评论」余量与下一轮回评时间；新增卡「截图库」
  （网格缩略图 img + 删除按钮，读 /shots）；卡5 保持发帖确认。
- **README** 补六件新功能用法与风险说明。
- **测试增补**（test/xhs.test.mjs）：@主人 happy path + mention 失败不算停手、
  shareTo dm/both 的站内分享 + 失败回落 QQ、关键词隔轮交替、
  视觉（假 askModel 返回描述 → think prompt 里含「画面：」；canSeeImages false → 不调）、
  截图库 saveShot 去重与 maxKeep、replyComments 全链路（seen 去重/capReply/dryRun）、
  sendImageToOwner 在 pauseAll 里被调。fake site 按契约 §6 扩展对应方法。

## 10. 验收分工

- 成员各自 `node --check` + 各自新增纯函数的本地冒烟；全量 `--test`、`catalog/check/pack`、
  重装本机、**面板刷新验证**由 Lead 收口做（含 zip 时间戳 1980 对 watcher mtime 的影响排查）。
