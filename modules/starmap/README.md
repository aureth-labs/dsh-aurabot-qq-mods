# 星图

把 Aurabot 自己的记忆库渲染成一张可交互的 3D 星图。

- 数据源：Aurabot 的 `memory.sqlite`，通过内置 `memory` 模块读取
- 节点：长期记忆、每日摘要、人物小档案、老爹/群友等会话枢纽
- 交互：拖动旋转、滚轮缩放、搜索记忆；点星星看正文
- 面板：安装后在「已安装」或顶部「星图」打开
- 页面随模块分发，不依赖 AstrBot，也不会把记忆上传到任何地方

## 安装

Aurabot 插件 **1.2.0 及以上**，在面板「模块市场」安装后启用即可。

## 权限

- `filesystem`：读取模块自带的 `assets/page.html`
- `plugin-internals`：通过 `api.use('memory')` 读取 Aurabot 记忆
- `network`：页面里的 `fetch('graph')` / `fetch('node?id=')` 只请求本模块的同源接口，不访问外网。页面是 `.html`，仓库的能力扫描会把它算成 `network`，所以这里显式声明

不写用户文件，不修改记忆。

## 测试

```sh
node --test "modules/starmap/test/*.test.mjs"
```

覆盖三块：

- 数据：长期记忆 / 摘要 / 小档案 / 会话枢纽怎么变成节点，去重、700 节点上限、连线剪枝、正文
- 布局：星体尺寸（会话枢纽 7、档案 6、摘要 4.2、单条记忆按被想起次数增长）和页面配色契约（服务端发的每个 `type` 页面都有对应颜色）
- 面板与路由：`panel.js` 能按插件的方式解析、iframe 指向 `/page`；`/page` `/graph` `/node` `/health` 的返回和 15 秒缓存

## 来源与许可

`assets/page.html` 和 `lib/` 都是 **zcx1021** 写的。最早的原型是作者自己的 AstrBot 本地插件
`astrbot_plugin_memory_sea`（识海，`metadata.yaml` 里 `author: local`，没有上游仓库），
做这个模块时按 Aurabot 的模块路由重写了取数接口和路由，页面沿用同一作者的代码：
只沿用了「把记忆画成星图」这个交互形式，包内没有 AstrBot 主仓（AGPL-3.0）的代码。

所以本模块按 **MIT** 分发，`LICENSE` 为 MIT 全文，© 2026 zcx1021。
