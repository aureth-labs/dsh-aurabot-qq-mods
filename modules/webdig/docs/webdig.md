# webdig —— 把一个网站的数据挖出来

拿网页不用一张张点。给它一个网址，它自己去找数据在哪、抓下来、告诉你怎么读。

**它守的规矩**：先读 robots.txt，明确 Disallow 的路径直接跳过；默认每次请求之间停 800ms（可用 `--delay` 调），不连着砸人服务器；只抓公开可访问的内容，不碰登录态、不绕验证码、不伪装成别人。

## 用法

```powershell
node "C:\Users\12157\.dsh\plugins-data\aurabot\scripts\webdig.mjs" <网址> [--out 目录] [--max N] [--delay 800] [--deep]
```

- `--out`：落盘目录，默认当前目录下的 `webdig-out`
- `--max`：最多抓几个数据地址，默认 20
- `--delay`：每次请求间隔毫秒，默认 800
- `--deep`：顺着脚本再往下扒一层（站点脚本嵌套深时用）

例：

```powershell
node "...\webdig.mjs" https://latent-archive-y0xucg7embg.qoder.website --out D:\tmp\dig
```

## 它做四件事

1. **读 robots.txt**，明确禁止的路径跳过
2. **抓首页**，从 `<script src>` / `<link href>` / inline 脚本里找线索
3. **抓页面内嵌数据**：`ld+json`、`__NEXT_DATA__`、`window.__INITIAL_STATE__` / `__NUXT__` ——这条命中率最高，页面自己就带着整份内容
4. **扒脚本找接口**：`fetch('x.json')`、`axios.get(...)`、字符串里像 json/api/data 的路径，然后逐个抓

## 输出

```
index.html          首页原文
js-*.js             脚本原文
data-*.json         抓到并格式化好的数据
embedded-*.json     页面内嵌的那份数据
raw-*               不像 json 的响应
summary.json        全量摘要（含内容线索、抓不到的清单）
```

`summary.json` 里的 `arrays` 最有用，会直接写：

```
内容线索 data.json → works（56 条，字段：id, t, pr, ng, mk ...）
```

看到这条就知道该去读哪个文件、哪个字段。

## 踩过的坑

- **`fetch('data.json')` 的相对路径按「页面地址」算，不是按「脚本地址」算。**
  只按脚本地址拼会多一层 `assets/`，拿到的就是 404。脚本里两种 base 都试，纯文件名优先用页面地址。
- **豆瓣这类站会 302 到验证码页**，返回内容只有几 KB。脚本会提示「首页只有 N 字节，很可能是被反爬拦了」，不会让你误以为页面里本来就没东西。
- **大站（B 站、少数派）的接口要签名参数**，能挖到地址名但直连不一定有数据。这种得单独适配，不是脚本能通吃的。
- 有些站是**前端跑 JS 才出内容**，静态抓不到。脚本会如实说抓不到，不编。
- **robots.txt 是 404 不等于允许无限制抓**：只说明站方没写规则。真正稳妥的还是低频、少量、只取自己要看的那部分。

## 在聊天里直接用（模块版）

不用自己敲命令。已经包成一个 aurabot 模块：

```
plugins-data/aurabot/modules/webdig/index.mjs
```

注册了工具 `qq_web_dig`，她可以自己调。用法就是给她一个网址，它会：

1. 先读 robots.txt，禁止的路径跳过
2. 跑这个脚本，落盘到 `modules-data/webdig/out/<时间戳>/`
3. 回一句摘要（多少字节、抓到几个 JSON、哪段字段有内容、被拦了没有）

**路径要点**：模块里 `api.dataDir()` = `plugins-data/aurabot/modules-data/webdig`，
往上**两级**才回到 `plugins-data/aurabot`，再进 `scripts/`。写三级会指到 `plugins-data/scripts/`（不存在）。

模块改完保存后，在插件管理器里重载一次 aurabot 就生效。

## 谁在用

大肥鱼查提示词站（2026-11-04）。用它从 `latent-archive-y0xucg7embg.qoder.website` 拿到 56 件作品的正/负向词和参数，没点开过一张卡片。
