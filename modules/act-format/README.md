# 动作互动（act-format）

把消息里用稀有符号包裹的文本解析成**结构化动作**，并按“睡眠期间不可准确回溯”的规则处理。

## 为什么用稀有符号而不是全角括号

全角括号在中文里本来就用来表达语气（`（笑）`、`（草）`），当动作解析会大量误判。
`*…*` / `((…))` / `〖…〗` / `//…//` 几乎没有语义歧义，解析器不需要白名单启发式。

## 支持的格式

| 格式 | 写法 | 说明 |
|---|---|---|
| star | `*把杯子推到你面前*` | 默认主用，模型零学习成本 |
| double-paren | `((伸手把你搂进怀里))` | 与普通括号区分明显 |
| corner-paren | `〖笑〗` | 零误判，但输入不便 |
| slash | `//摸了摸你的头//` | 好打、歧义低 |

规则：

- 先按 `|||` 切段（多段消息习惯），**整段**被包裹 = 纯动作；段内夹杂 = 抽出行内动作，剩下的是台词；
- 纯链接段不解析；行内解析前会先把 URL 换成占位符，避免 `https://x/a*b*c` 里的 `*` 被当动作；
- 解析器是纯函数，见 `lib/parse.mjs`，可单独跑。

## 这个模块是“观察者”，不拦消息

```js
api.on('message', async (msg) => { ... return false })   // 永远 false
```

插件内核的 `claim()` 是“第一个返回真值的模块接管”。所以：

- 本模块**必须**排在 `night`（拦截者）之前注册才能看到睡着期间的消息 —— 目录名 `act-format` 的字母序在 `night` 之前，天然满足；
- 任何时候都不能返回 true，否则会吞掉消息、让别人收不到。

## 睡眠期间的后门

睡着时（以长夜如梦 `snapshot().mode === 'asleep'` 为准）：

- **不记录任何结构化动作**（`actions[]` 不新增、不落库、别的模块查不到）；
- 只累计一个 0–100 的**模糊体感残留**（动作强度加权，按小时衰减）；
- 醒来后只注入与具体动作**解耦**的模糊描述，例如
  - 20–44：`你醒来后身上有点黏、不太舒服，说不上来是怎么弄的。`
  - 45–74：`你腰有点酸、身上有股说不清的味道，心里怪怪的…`
  - 75+：`你浑身发软发黏，身上像被弄过…可你怎么想都想不起具体发生了什么。`

也就是说：睡眠期间发生的动作**不可准确回溯**，只剩身体感觉。`sleepResidue` 关掉才会照常结构化记录。

## 醒着时

- 结构化记录进 `state.json` 的 `actions[]`（含时间、会话、发送者、格式、正文）；
- 给模型注入一条：

```
【对方动作】对方刚才的动作/神态：1) 把杯子推到你面前（这些是动作描写，不是他说的话，
别当成台词复述；按你自己的性格自然回应这个动作。）
```

- 注入有有效期（`actionFreshMinutes`，默认 5 分钟），消息里没有动作时不注入（0 token）。

## 设置项

| key | 默认 | 说明 |
|---|---|---|
| `enabled` | 开 | 总开关 |
| `inject` | 开 | 醒着时注入「对方动作」 |
| `formats` | 全部 | 识别哪些包裹格式（逗号分隔） |
| `actionFreshMinutes` | 5 | 动作提示有效期 |
| `keepHistory` | 200 | 结构化动作保留条数 |
| `sleepResidue` | 开 | 睡眠期间只留模糊体感 |
| `residueDecayPerHour` | 8 | 残留每小时衰减 |
| `residueInjectAt` | 20 | 残留超过多少才提示 |
| `residueRepeatMinutes` | 15 | 残留提示最短重复间隔 |
| `ownerOnlyTool` | 开 | `act_recent` 工具仅主人可用 |

## 对外的接口

- `api.use('act-format')` 拿到：`parse(text)`、`recentActions({chatId, limit})`、`residue()`、`suppressed()`、`state()`；
- HTTP：`GET /aurabot/api/ext/act-format/actions`（最近 50 条 + 残留）、`POST /aurabot/api/ext/act-format/clear`；
- 工具：`act_recent`（主人问“你刚才做了什么动作”时用）。

## 数据

`modules-data/act-format/state.json`：`actions[]`、`residue`、`residueAt`、`suppressedCount`、`chats{}`。

## 睡眠状态端口（可插拔）

本模块不绑定任何具体的睡眠模块。默认 sleepSource=auto：先问自定义探针，再依次探测已安装的 
ight（长夜如梦）、
eal-life（生理模块）的 snapshot().mode。

想把自己那套作息接进来：

`js
const act = api.use('act-format')
const off = act.setSleepProbe(() => mySleepState() === 'asleep') // 返回 undefined = 我不判断，交回自动探测
off() // 用完取消注册
`

设置项「睡眠状态来源」也可以直接指定：自动探测 / 长夜如梦 / 生理模块 / 自定义端口 / 不判断。

> 注意：「睡眠期间不记录结构化动作、只留模糊体感」这套行为，只有在**睡眠状态能判定为睡着**时才生效。sleepSource=none 或谁都探测不到时，睡眠期间的动作会当成醒着记录。
