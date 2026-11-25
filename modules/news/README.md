# 每日新闻一图流（news）

每天挑几条国内近期新闻，让她画成一张中文信息图，连来源链接一起发过来。

## 做什么

| 能力 | 说明 |
|---|---|
| 每日自动 | 默认北京时间 08:00 生成一张；错过会当天补发，失败每 30 分钟重试，最多 3 次 |
| 手动生成 | 主人在 QQ 里发 `/news`，结果回到当前聊天 |
| 面板 | 开关、时间、条数、关注主题、新闻源、画风 |
| 来源 | 每条新闻附带原文链接，单独一条消息发出 |

## 依赖

需要先在「生图」页启用并配置生图服务。模块通过 `api.use('imagegen')` 调用它生成图片；没配置时会在日志里提示，不会静默失败。

## 用到的网络地址

默认新闻源（面板里可以改，一行一个，最多 8 个）：

- `https://www.chinanews.com.cn/rss/china.xml`（中新网·国内）
- `https://www.chinanews.com.cn/rss/society.xml`（中新网·社会）
- `https://www.chinanews.com.cn/rss/finance.xml`（中新网·财经）
- `https://www.ithome.com/rss/`（IT之家）
- `https://www.solidot.org/index.rss`（Solidot）
- `https://sspai.com/feed`（少数派）

只读取这些公开 RSS/Atom 源，不会把聊天内容、Cookie 或账号信息发到任何第三方地址。抓取前会先解析域名并拒绝指向内网/本机的地址，避免被当成内网探针。

## 数据存放

任务状态写在用户自己的数据目录：`plugins-data/aurabot/modules-data/news/daily-state.json`（记录今天第几次、发过哪些聊天、失败次数），不随模块分发。

## 权限说明

`module.json` 的 `capabilities`：

- `network`：抓取上面那些 RSS 源
- `filesystem`：读写自己的任务状态文件
- `plugin-config`：读写面板设置（新闻源、画风、时间等）

没有 `process` / `dynamic-code`，不启动外部程序，也不在运行时下载并执行代码。

## 安装

面板「模块市场」搜索「新闻」安装，或把这个文件夹放进 `plugins-data/aurabot/modules/news/`。

## 许可

MIT，见 `LICENSE`。
