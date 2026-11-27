# 自动切换模型

Aurabot 1.3.0 的用户模块，按每天时段、星期、指定日期或当前会话人格选择聊天模型。支持条件组合、跨午夜和优先级。零 npm 依赖。

## 安装

把整个 `auto-change-model` 文件夹放到 Aurabot 数据目录的 `modules/` 下。默认数据目录为 `~/.dsh/plugins-data/aurabot/`；若设置了 `AURABOT_DATA_DIR` 则以该值为准。约几秒后在 Aurabot「已安装」中看到「自动切换模型」。这是 Aurabot 模块，不能把模块目录直接当 DSH bundle 安装。

首次安装默认不启用自动切换、规则为空。打开模块设置，填写时区与规则 JSON 数组，保存，再点击「检查已保存规则 / 刷新模型与人格」。从返回列表复制准确的 provider、model 和人格 id，完成后打开「启用自动切换」。模型凭据仍在 DSH 的模型设置中配置，不放进规则。

## 配置示例

以下 ID 是占位示例，必须替换为本机列表中的 ID。复制整个数组到「规则 JSON 数组」：

```json
[
  {
    "id": "work-persona",
    "priority": 100,
    "personas": ["work"],
    "provider": "YOUR_PROVIDER",
    "model": "YOUR_WORK_MODEL"
  },
  {
    "id": "special-day",
    "priority": 80,
    "dates": ["2026-12-01"],
    "provider": "YOUR_PROVIDER",
    "model": "YOUR_SPECIAL_MODEL"
  },
  {
    "id": "weekend",
    "priority": 50,
    "weekdays": [6, 7],
    "provider": "YOUR_PROVIDER",
    "model": "YOUR_WEEKEND_MODEL"
  },
  {
    "id": "daytime",
    "priority": 10,
    "start": "08:00",
    "end": "22:00",
    "provider": "YOUR_PROVIDER",
    "model": "YOUR_DAY_MODEL"
  },
  {
    "id": "night",
    "priority": 10,
    "start": "22:00",
    "end": "08:00",
    "provider": "YOUR_PROVIDER",
    "model": "YOUR_NIGHT_MODEL"
  }
]
```

要只按人格切换，保留人格规则即可；只按日切换，可用 weekdays 指定每周哪天或 dates 指定日历日期。未写时间的日期规则整天有效。没有匹配规则时沿用面板原模型。

| 字段 | 含义 |
| --- | --- |
| id | 每条规则唯一的非空名字 |
| provider / model | DSH 中实际的完整标识，保留模型名中的斜杠 |
| enabled | 可选，默认 true；false 暂停这条规则 |
| priority | 可选，默认 0；数字越大越优先，同分取数组靠前的规则 |
| personas | 可选，人格 ID 数组，精确匹配，不是显示名或人格正文 |
| weekdays | 可选，1=周一，7=周日 |
| dates | 可选，YYYY-MM-DD 日期数组 |
| start / end | 成对填写，24小时 HH:mm；包含开始、不包含结束；相同表示全天 |
| reasoningEffort | 可选，使用目标模型实际支持的字符串；省略则清空上一模型的推理档位 |

所有条件同时满足才命中；条件数组为空与省略等价。未写任何条件的规则可作兜底，建议把 priority 设得最低。时区默认 Asia/Shanghai，也可填写其他 IANA 时区。夏令时跳过的本地时间不出现，重复的小时两次都按相同规则匹配。

跨午夜的早晨归开始日：`weekdays:[5], start:"22:00", end:"08:00"` 表示周五22点至周六8点；dates 也按开始日判断。普通全天规则在当地午夜换日。

## 生效范围与边界

- 使用官方同步 `model` 事件，每次宿主为聊天选模型时重新计算。从下一条聊天消息起应用，不中断已在生成的回复。无需后台轮询，也无需写全局模型配置；没有新消息时不会发起模型请求。
- 匹配时覆盖 Aurabot 的「按聊天选模型」。其他也监听 model 的模块仍可能随后覆盖本模块结果，应避免重复配置互相冲突的模块。
- 人格从宿主 AsyncLocalStorage 上下文读取，并使用宿主的缺失人格回退规则。多个会话并发时按各自所属人格路由，不使用全局人格替代正在进行的旧会话。
- 只覆盖经过 Aurabot 聊天 model 事件的请求；DSH 普通编程会话、模块自行 api.ask 的请求不在此范围。
- JSON、时区或规则字段有误时整个配置停止覆盖并记录日志；修正保存后恢复。不悄悄运行旧规则。人格接口不兼容时同样停止覆盖。
- 同一聊天通过 `/effort` 保存的同模型推理档位仍由宿主在本模块之后覆盖；空字符串或不支持的档位由宿主回退到模型默认值。
- 模型 ID 与推理档位需自行从可用列表及模型设置核对；本模块不发付费探测请求、不替用户创建凭据，也不自动对请求失败切换备用模型。
- 关闭或卸载模块后宿主撤销事件监听，原来的模型配置自然恢复，无需恢复全局配置。

## 面板与隐私

提供检查按钮、当前匹配规则、模型 ID 列表和人格 ID 列表。检查接口仅供宿主管理面板访问，沿用 Aurabot 1.3.0 的面板访问与 CSRF 保护。不会注册 QQ 控制命令或自动发消息。

运行时不访问任何外部网址，不直接读写文件、不启动程序。声明 `plugin-config` 是因为读取人格配置，声明 `plugin-internals` 是因为使用宿主的人格上下文与模型列表。不会把 API Key、Cookie、人格正文返回到检查接口。模块设置由宿主持久化。

## 开发与验证

在项目根目录运行 `node --test --test-isolation=none modules/auto-change-model/test/*.test.mjs`。测试覆盖时间边界、跨日、时区/DST、人格规则、优先级、无效配置和模块事件接线。

依据：
- https://github.com/aureth-labs/dsh-aurabot-qq-mods/blob/main/docs/TUTORIAL.md
- https://github.com/aureth-labs/dsh-aurabot-qq/blob/main/src/modules/API.md
- https://github.com/aureth-labs/dsh-aurabot-qq/blob/main/src/persona/personas.js

人格上下文属于内部接口，升级 Aurabot 后应重新验证。本版本按 1.3.0 源码实现。
