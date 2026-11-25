# 萌娘百科（moegirl）

外接[萌娘百科](https://zh.moegirl.org.cn/)，让她在遇到不认识的动漫 / 游戏 / 声优 / 梗时能自己查。

## 它能做什么

- **搜**：给一个词，回来 5 条候选（标题 + 开头一段 + 链接）
- **读**：给准确条目名，回来正文开头（默认 1200 字，可调）
- **缓存**：查过的条目存本地，24 小时内不重复请求

## 在聊天里怎么用

她会在遇到不熟的二次元名词时自己用这两个工具：

| 工具 | 干什么 |
|---|---|
| `moegirl_search` | 搜条目，拿候选名 |
| `moegirl_page` | 读某个条目的正文 |

也可以手动喊：

```
/萌娘 初音未来
/萌娘 东方Project
```

别名：`/萌百`、`/moegirl`。给的是准确条目名就直接回正文，不是就自动转成搜索。

## 设置项

| 项 | 默认 | 说明 |
|---|---|---|
| 打开 | 开 | 总开关 |
| API 地址 | `https://zh.moegirl.org.cn/api.php` | 一般不用动 |
| HTTP 代理 | 空 | 直连能通就留空；域名被解析成 fake-ip（198.18.x.x）时填 `http://127.0.0.1:7890` |
| 一次搜几条 | 5 | 1–10 |
| 正文最多回多少字 | 1200 | 200–6000 |
| 缓存多久 | 1440 分钟 | 0 = 不缓存 |
| 群里也能查 | 开 | 关掉就只对私聊生效 |

## 接口（给面板 / 脚本用）

前缀 `/aurabot/api/ext/moegirl`：

- `GET /state` — 开关、缓存条数、当前设置
- `GET /search?q=初音未来` — 搜索
- `GET /page?title=初音未来` — 读正文
- `GET /test` — 拿「初音未来」跑一遍，看通不通
- `GET /clearcache` — 清空本地缓存

## 踩过的坑（改这个模块前先看）

- **`list=search` 和 `list=prefixsearch` 都被关了**，返回 `action-notallowed / Unauthorized API call`。能用的搜索路子只有 `generator=search`。
- **HTML 搜索页直接 403**（`/index.php?search=xxx&fulltext=1`），别想着抓页面。
- `prop=extracts&explaintext=1` 拿整条正文很好用，但长条目能到 2 万字以上，所以一定要限长再回给她。
- 走 HTTP 代理要自己 `CONNECT` 建隧道再套 TLS（Node 的 `fetch` 不读系统代理）；填了「HTTP 代理」就会走这条逻辑。

## 许可

MIT
