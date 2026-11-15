# 抖音评论 / @ / 点赞 / 分享失败排查（#38）

> 群友反馈：只能刷抖音，评论、@、点赞、分享都有概率失败，日志里全是失败；分享成功 2 次、@ 全失败、评论成功 2 次，怀疑被平台判成新号，也怀疑平台改了 HTML。
> 这份文档记录代码里各操作的实现路径、这次做的兜底和日志分类，以及还需要用户提供什么才能定到具体原因。

## 各操作走哪条路

| 操作 | 页面选择器 / 接口 | 常见失败点 |
|---|---|---|
| 点赞 | 弹层播放器 `[data-e2e="feed-active-video"][data-e2e-vid=…]` 里的 `[data-e2e="video-player-digg"]`，点完等 `/aweme/v1/web/commit/item/digg/` | 按钮选择器改版、账号验证（响应头 `x-tt-verify-passport-decision`）、接口没回执 |
| 评论 | `.comment-input-inner-container [contenteditable="true"]`，发送按钮是输入框上方图标栏最右一个，点完等 `/aweme/v1/web/comment/publish` | 评论框 / 发送按钮选择器改版、`bd-ticket` 强校验、账号验证 |
| @ 主人 | 输入 `@昵称` 后从 `.atBox-inner-container` 候选里按 React props 的 `sec_uid` / `uid` 认人，点选后检查 `.douyin_mention_word` | 候选 DOM / React 内部结构改版、候选点击被当成不可信事件、互相没关注导致候选里没人 |
| 分享到私信 | 分享面板里按 React props 的 `sec_uid` 找联系人行（高度 30–90），点「分享」等 `/v1/message/send/` | 面板结构改版、找不到主人（互相没关注 / 私信不通）、HTTP 200 但业务失败或要求验证 |

这几条路互不相同，但共用同一个浏览器登录态和账号。**如果四种同时大面积失败，先怀疑账号侧风控 / 验证**；如果只有 @ 或只有分享失败，更像对应页面的选择器或关系限制。

## 这次改了什么（2.3.9）

1. **失败分类**：`lib/failure.mjs` 把错误分成 `risk`（验证码 / 风控 / 频繁）、`login`、`limit`（额度 / 间隔）、`target`（找不到分享或 @ 的人）、`selector`（页面结构）、`network`（没回执 / 接口）、`uncertain`、`api`、`unknown`。点赞 / 评论 / 分享 / 主动私信 / 看私信的日志和 state 都带上分类，例如：
   `[douyin v2.3.9] 抖音点赞失败[selector] aweme=7675…：页面上找不到点赞按钮（试过 6 种选择器）`
2. **选择器兜底**（主选择器不变，失败后才试后面的）：
   - 点赞按钮：`video-player-digg` → `feed-digg-icon` → `[class*="video-player-digg"]` → `[data-e2e*="digg"]` → 带 like / 赞 aria 的按钮；
   - 评论框：`comment-input-inner-container` 的多种 class / `[data-e2e="comment-input"]` / textarea；
   - 发送按钮：优先 `[data-e2e="comment-submit|comment-post|comment-publish"]` 和 aria 文案，找不到再走原来的图标启发式；
   - @ 候选：React props 认不出时按候选文字 `@昵称` 兜底，并改用 CDP 真鼠标点击（不再只派发页面内 MouseEvent）。
3. **分享回执校验**：以前只看 HTTP 200；现在 HTTP 200 但带账号验证标记或 `status_code != 0` 也会报失败并归类，不再把被拦下当成功。

## 还需要用户提供（缺了这些只能猜）

请群友在面板「日志」页筛 `douyin`，复制失败时间点前后 10–20 行，至少包括：

- **模块版本**（面板模块市场里「刷抖音」的版本，如 `2.3.9`；日志行里也会带 `[douyin v2.3.9]`）
- 系统 / DSH 版本
- 抖音号是不是新号、最近有没有在手机抖音被要求验证 / 实名
- 日志里这些行（有哪条给哪条）：
  - `[douyin v…] 抖音点赞失败[...]`
  - `[douyin v…] 抖音评论失败[...]`
  - `[douyin v…] 抖音里分享给主人失败[...]`
  - `@ 候选里没找到主人` / `@ 候选没弹出来`
  - `看 / 回主人抖音私信[...]`
- 失败是每次都失败还是偶发；如果 @ 全失败，主人和机器人号是否互相关注 / 能互相搜到
- 可选：面板「显示浏览器窗口」截一张失败时页面（验证码 / 滑块 / 登录页）

## 已知限制

- 云主机不能登录真实抖音号，无法做真实页面回归；上面的选择器兜底来自公开项目常用的抖音网页结构，不保证覆盖最新改版。
- 如果日志里分类是 `risk`（特别是 `x-tt-verify-passport-decision`），不是代码能绕的：按 README「身份验证」处理，先别再反复重试。
