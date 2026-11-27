# 私聊每日拆分（private-daily-session）

只在私聊里按天开新会话：跨天 + 静默够久 + 不在回复中，三道闸全满足才动手。摘要优先读 history-vault 已有的日摘要，没有才退回调模型，不重复烧 token。

## 为什么要另写一个

市场里的 daily-session 直接调 `hub.resetChat(chatId)` 且不查是否在回复中，私聊拆到一半会断片；它每次都自己 `api.ask` 提炼摘要，跟 history-vault 重复花钱；按固定时刻拆会插在聊天中间。这个模块：

1. 先过三道闸：周期跨天了、这个私聊静默够久、当前不在回复中。
2. 摘要优先读 history-vault 的 `vault_days`，拿不到才调模型，且读原始 chatlog 绕过 memoryCutoff 过滤。
3. 用「静默 ≥ idleMinutes」而不是固定时刻，避免白天误拆。
4. 重置只调 `hub.resetChat(chatId)` 不传 `memoryResetAt`——不做遗忘标记、不动记忆和流水。

## 配置

- 开启私聊拆分（默认关：先看日志跑一阵）
- 每天几点后算新的一天（默认 4，凌晨 4 点前仍算昨天）
- 静默多少分钟才拆（默认 300，实测白天最长空档 279 分钟、过夜 722~757 分钟）
- 新会话首轮带上摘要 / 摘要字数上限（默认 300）
- 试运行（默认开：只写日志不真重置，确认不会插在聊天中间再关）
- 没有现成摘要时是否调模型提炼 / 提炼输出 tokens

## 怎么用

- 面板开关 + 命令 `/私聊拆分 [状态|现在|摘要]`。
- 调试接口：`/status`、`/probe`、`/dry-digest?day=YYYY-MM-DD`（看某天会压出什么摘要）、`/dry-context`（演算新会话首轮注入什么，不写状态）、`/run-now?force=1`（调试强制重跑）。

## 会访问哪里

本机 Harness 的 history-vault `/read` 接口 + 本机 chatlog jsonl 文件；调模型只走插件自身的 `api.ask`。不联网、不向外发消息。
