# 表情进阶

按**内容**检索表情，不是按文件名猜。

需要配合 [`stickers`（表情包）](https://github.com/aureth-labs/dsh-aurabot-qq-mods/tree/main/modules/stickers) 模块使用 —— 它提供表情库，本模块负责按语义检索。

## 做什么

表情的「知识」不是文件名，是每张图的内容：

- 画面描述（图里是什么）
- 梗出处（这个梗哪来的）
- 使用场合（什么时候用）
- 情绪（开心、委屈、无语……）
- 方向（横图、竖图、方图）
- 图上文字

所以她说「找个委屈的」「找那个鲸鱼吃饭的梗」「有没有适合被夸了不好意思的」，都能搜到。

## 怎么用

### 工具

| 工具 | 作用 |
|---|---|
| `sticker_find` | 按画面/梗/场合/情绪/图上文字检索表情 |
| `sticker_stats` | 看表情库统计（总数、可用数、情绪分布） |

### 例子

- 「找个开心的表情」→ `sticker_find` 搜情绪
- 「有没有适合被骂了还嘴硬的」→ `sticker_find` 搜场合
- 「有多少表情」→ `sticker_stats`

## 检索怎么工作

对每个字段（name / tags / emotion / use / summary / text）做关键词打分：

- 精确命中权重高
- 部分命中按比例给分
- 多个字段同时命中会累加
- 中文按字切分，支持短词匹配

实现见 `lib/lib-search.mjs`（从 [dsh-nekowhale-stickers](https://github.com/Loping151/dsh-nekowhale-stickers) 移植，MIT）。

## 会访问哪些网址

**不联网。** 这个模块不请求任何外部网址。

表情数据全部来自本机的 `stickers` 模块。

## 依赖

- **`stickers`（表情包）模块** —— 提供表情库。没有它，本模块没有数据可检索。
- 无 npm 依赖，纯 JS。

## 隐私

- 只读 `stickers` 模块的表情库（同一份本地数据）
- 不上传任何东西
- 不联网

## 数据在哪

表情库在 `plugins-data/aurabot/stickers/index.json`（由 stickers 模块维护）。

## 需要什么

- Aurabot 插件 1.2.0 或更高
- **`stickers` 模块**

## 第三方

检索算法和表情知识库结构来自 [dsh-nekowhale-stickers](https://github.com/Loping151/dsh-nekowhale-stickers)（作者 Loping151）。按原作者要求，**必须保留 NOTICE**（见本目录的 `NOTICE`）。

表情美术：可以叫我云大人 / 麒麟雪（[Bilibili](https://space.bilibili.com/103739)、[kiriyuki.com](https://kiriyuki.com)）

## 许可证

MIT