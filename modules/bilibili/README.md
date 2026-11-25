# 回b站@（bilibili）

别人在 B 站评论区 @ 她、或者互关的人给她发私信，她会自己去回一句。

用的是**她自己的 B 站账号**，所以需要先填 Cookie。

## 怎么用

1. 面板 →「已安装」→ 找到「回b站@」→ 打开。
2. 在 Aurabot 配置里的 `bili` 段填 B 站 Cookie（整串粘贴最省事，必须含 `SESSDATA` 和 `bili_jct`）。
3. 打开「只回主人的 @」，在「主人的 B 站 UID」里填你自己的 mid（主页链接末尾那串数字）。
4. **先别关「只演练不发」** —— 等日志里出现 `回b站@（试运行）：本来要回 xxx：…`，看看口气对不对。
5. 口气满意了，关掉「只演练不发」，它就开始真回。

也可以在 QQ 里发 `b站` 看今天回了几条；接口手动跑一次：`POST /aurabot/api/ext/bilibili/check`。

## 回什么、不回什么

| 来源 | 回不回 |
|---|---|
| 评论区 @ 她 | 回（可关） |
| 互相关注的人发的私信 | 回（可关） |
| 陌生人 / 营销号的私信 | **不回**（靠互关过滤） |
| 系统通知、活动提醒、登录提醒 | **不回**（内容里没有正文，直接跳过） |
| 超过 24 小时的 | 不回 |
| 同一条 | 只回一次 |

## 为什么不再看「未读」

早期版本靠 `unread_count` 判断有没有新私信，但**只要你在手机或网页上点开看过一遍，未读数就归零**，模块会以为没有消息、永远不回。

现在改成看「**会话里最后一句是谁说的**」：只要最后一句是对方说的，就算没回，接着回。连续几句没回会合并成一次回复，不会一条条刷。

## 每天上限

默认每天最多 10 条（评论 + 私信合计），到上限就等第二天。私信一轮最多翻 2 个会话、名字和互关状态都缓存 10 分钟，避免触发 B 站的 `-509 请求过于频繁`。

## 会访问哪些网址

全部是 B 站官方域名，Cookie 只发给这些地址，不发往任何第三方：

- `https://api.bilibili.com/x/msgfeed/at` —— 读「@我的」
- `https://api.bilibili.com/x/web-interface/nav` —— 读自己的 mid
- `https://api.bilibili.com/x/relation` —— 查是不是互关
- `https://api.bilibili.com/x/web-interface/card` —— 查对方昵称
- `https://api.bilibili.com/x/v2/reply/add` —— 发评论回复
- `https://api.vc.bilibili.com/session_svr/v1/session_svr/get_sessions` —— 列私信会话
- `https://api.vc.bilibili.com/svr_sync/v1/svr_sync/fetch_session_msgs` —— 读某个会话的消息
- `https://api.vc.bilibili.com/web_im/v1/web_im/send_msg` —— 发私信

## 会写什么文件

只写模块自己的数据目录：`state.json`，记已经回过哪些 @ / 私信、今天回了几条。最多留 300 条记录。

## 注意

- 这个模块**会真的以你的名义发评论和私信**。默认演练模式就是为了让你先看清楚它会说什么。
- 建议开着「只回主人的 @」，不然任何人在评论区 @ 一下都会触发。
- 不要为了刷量把「每天最多回几条」调得很高，B 站会风控。
- Cookie 过期后会报「拿不到自己的 uid」，重新粘一次 Cookie 就好。

## 能力声明说明

- `network`：要连 B 站接口读 @ 和私信、发回复。
- `filesystem`：只写模块自己的 `state.json`。
- `plugin-config`：读配置里的 `bili` 段拿 Cookie 和 `bili_jct`（**只读，不写**，也不会把 Cookie 发给 B 站以外的地址）。
- `plugin-internals`：只用了 `api.core.hub.logChat` 把「谁 @ 了她、她回了什么」记进聊天日志，方便在面板里回看。

**没有使用 `runSubagentTurn`** —— 本模块不 spawn 任何带 shell / 文件工具的子智能体，不存在把外部文本拼进任务书的风险。

## 许可证

MIT
