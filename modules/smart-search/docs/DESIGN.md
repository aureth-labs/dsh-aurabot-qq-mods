# 设计与接口

## 原生工具，不额外挂一套智能体

使用 Aurabot `api.tool`、`api.defineTool` 和 `api.rule`，只向 Aurabot 聊天注册工具。没有修改 DSH 的 agent preset、人格文件、全局工具注册表或其他模块。

```
QQ 提问 → 当前聊天模型
            ├─ qq_web_search → 选源 / 并行 / 有界换源 → 摘要、来源
            ├─ qq_read_webpage → 安全直读 / 服务商提取 → 网页文本
            └─ qq_search_docs → Context7 库候选 → 指定库的相关片段
          ←  模型判断是否补查，最后回答并引用来源
```

本地路由为明确的优先顺序，不是相关性评分模型：技术文档优先 Exa / Firecrawl，中文普通检索优先智谱，英文新闻优先 Tavily，其他问题优先 DSH / SearXNG。只有启用且已配置的渠道参与。模型可通过 `sources` 指定来源、`mode=verify` 请求多源核对；面板的策略与上限始终优先。

没有独立 Jev、二次汇总模型或嵌套研究循环。判断证据是否足够、改写检索词和决定后续读取由当前聊天模型负责；模型工具调用行为最终仍取决于它的能力和宿主限制。

动态规则和工具描述共同约束搜索时机：所需事实拿不准就查，普通聊天及仅改写、翻译已有内容不查；个人信息缺口询问用户。普通问题通常一次检索，有具体证据缺口才补查。复用本轮资料，权限、配置和额度错误直接停止，不通过重复换词重试绕过。没有把所有问题都强制查网，也没有增加另一套模型判断器。

读网页默认优先启用且可用的直接读取渠道（DSH / 智谱 / SearXNG），没有这类渠道时才默认用已启用的提取服务。模型明确指定服务时尊重其选择。

## 为什么没有包装 smart-search

调研版本：`@konbakuyomu/smart-search` **0.1.34**，2026-11-13。

- npm 入口是原生可执行程序启动器，分平台依赖中携带 Python 和依赖；并非可直接 import 的纯 JavaScript 搜索库。
- 上游普通 `search` 选择一个渠道，允许同能力故障兜底；`research` 才执行多渠道、正文读取、充分性判断和补搜。`deep` 命令本身生成离线计划。
- Jev 路由、研究判断及可选汇总有额外凭据和配置。Aurabot 已有当前聊天模型，重复引入会增加安装与运维成本。
- 检查了 GitHub 热度较高的几个 fork，未找到能直接替换为轻量 Aurabot 适配器的现成版本。

保留多源、权限边界、证据区分、预算与部分失败可见的思路，直接接服务 API。没有复制 smart-search 代码，也不声称兼容其 CLI、全部 provider 或完整 research 行为。

来源：[上游仓库](https://github.com/konbakuyomu/smartsearch)、[Jev 选路说明](https://github.com/konbakuyomu/smartsearch/blob/main/docs/jev-routing.md)。

## 接口细节

- DSH：`api.dsh.get('web').search({query, maxResults}, signal)`，读取 `sources`，不把生成式 `content` 当来源证据。可用性检查同时处理 provider 选择失败；DSH 当前 `searchReady` 在选择失败时仍可能返回 true。
- 智谱：`POST /paas/v4/web_search`，默认 `search_std`，关键词超过 70 字明确拒绝而不静默截断。
- Tavily：`POST /search`（basic、不开答案生成）、`POST /extract`。
- Exa：`POST /search`（auto）、`POST /contents`。
- Firecrawl v2：`POST /search`、`POST /scrape`（markdown）。
- SearXNG：`GET /search?format=json`，可指定引擎，保留部分引擎失败提示。
- Context7：`GET /api/v2/libs/search`、`GET /api/v2/context`。不把库目录介绍当成读到文档。

Tavily / Exa / 智谱传各自支持的时间条件；DSH / Firecrawl 用查询词提示；SearXNG 不支持 week 时按 month 查询并明确说明。域名在响应侧再次筛选。日期限制取决于索引质量，不能代替原文核对。

## 宿主依赖

密钥用 `api.lib('core/config.js').registerSecretField` 注册，复用原生表单的隐藏回显、空串保留和 null 清空语义，自定义面板使用 `draftSettings` / `setSettings` 接入页面底部统一保存。

权限在每次执行和返回前检查；不在工具构建时缓存主人权限。群聊使用 `turnSendersAllOwner`，不用 `turnHasOwner` 或群聊对象里的 userId 借权。设置变化会取消进行中的请求并清空缓存；模块停止时一并撤销工具、规则和请求。

HTTP 错误返回固定友好信息，不转发上游异常、响应体或堆栈。请求不会自动重试同一源；换源受来源范围、源数上限及按聊天计数共同约束。
