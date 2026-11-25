# aura-mimo · aurabot 模块

作者：**zcx1021**

用一段参考音频零训练克隆音色，调小米 MiMo TTS 合成语音，让她**用自己的声音说话**。

---

## 安装

1. 把整个 `aura-mimo` 文件夹放到：

   ```
   <dsh 数据目录>/plugins-data/aurabot/modules/aura-mimo/
   ```

   文件夹名**必须**是 `aura-mimo`，和 `index.mjs` 里的 `id` 一致。

2. 重启 aurabot，或等它在「模块」页自动重载。

3. 打开面板填 **MiMo API Key**（小米 MiMo 开放平台创建，`sk-` 开头），保存。

4. 点「发一条语音自检」验证链路。

> 想让它出现在顶层标签栏、且排在「世界」后面，需要额外改 aurabot 客户端的 `client.js`（见下方「标签位置」）。不改也能用，只是会落在「系统」页里。

---

## 参考音频

**本模块不自带参考音频。**

原先随包分发的两个预设（`dafeiyu1.mp3` / `dafeiyu2.mp3`）已撤下：这两个文件最初由一个公开获取的音色样本训练而来，但原始出处已无法追溯，授权状态无法核实。为了避免在产品里分发来源不明的声纹素材，已从包中移除。

要让她用自己的声音说话，需要自己准备一段参考音频：

- **面板上传**（推荐）：装好后在面板「aura-mimo」页上传一段 mp3 / wav，落在 `modules-data/aura-mimo/ref/`，不进模块目录。
- **放进 assets/**：把文件复制到模块的 `assets/` 目录，重启模块后出现在预设列表里。

要求：

| 项 | 建议 |
|---|---|
| 时长 | 几秒到几十秒，**越长合成越慢**（每次请求都要全量上传） |
| 格式 | mp3 / wav / m4a / flac / ogg |
| 大小 | 不超过 15 MB |
| 内容 | 干净的人声，背景噪声少，语速平稳 |

**关于声音权利的提醒**：克隆某人的音色之前，请确认你有权这样做——自己的声音、已获明确授权的他人声音，或者明确允许此类用途的素材。拿别人的声音冒充其本人可能涉及法律风险。

## 能力

| 项目 | 说明 |
|---|---|
| 工具 | `mimo_say` —— 她自己决定把某句话用语音说出来 |
| 命令 | `/语音 <文字>`（别名 `说话`、`say`） |
| 自动语音 | 按概率把回复里的短句换成语音条，可开关、可调概率 |
| 参考音频 | 内置「大肥鱼1」「大肥鱼2」，也可上传自己的 |
| 合成缓存 | 10 分钟内相同文字直接复用，命中时 0.004 秒返回 |

---

## 文件位置

模块 id 是 **`aura-mimo`**。

```
plugins-data/aurabot/modules/aura-mimo/
├── module.json        模块发布信息
├── index.mjs          模块主体
├── panel.js           面板界面
├── README.md
├── LICENSE
└── assets/            内置参考音频
    └── <任意名>.mp3     你自己的参考音频（可选，放进来就出现在面板预设列表）

plugins-data/aurabot/modules-data/aura-mimo/
├── ref/               你上传的参考音频
└── out/               合成结果（自动只留 20 个）
```

> 预设文件名是 ASCII 的，面板上显示成中文「大肥鱼1/2」。这样在任何系统、任何 locale 下解压都不会把中文名弄成乱码。

---

## 会访问哪里

| 能力 | 用在哪 |
|---|---|
| `network` | **只**请求你填的 `apiBase`（默认 `https://api.xiaomimimo.com/v1`）的 `/chat/completions`。不向其他地址发送任何数据 |
| `filesystem` | 在 `modules-data/aura-mimo/` 下写参考音频和合成结果（结果只留最近 20 个） |
| `plugin-config` | 读写本模块自己的设置（含 API Key）和主人 QQ（自检时用来发给自己） |
| `plugin-internals` | 用 `api.core.http` 收发面板请求 |

发送内容只有：参考音频（base64 放在请求体的 `audio.voice`）、要朗读的文字、风格提示词。**不会**把你的聊天记录、QQ 消息发给 MiMo。

### 标签位置不是靠字母序

`aura-mimo` 按字母序会排到很前面，**不会**自动落在「世界」后面。

顶层标签的顺序写死在 aurabot 客户端 `client/client.js` 的 `NAV_GROUPS` 数组里，每个分组用 `tabs: ['ext:模块id']` 绑定模块。要排在「世界」后面，必须在 `world` 那组之后手工加一组：

```js
{ id: 'world', label: '世界', icon: '…', tabs: ['ext:world', 'ext:world3d'] },
{ id: 'aura-mimo', label: 'aura-mimo', icon: '…', tabs: ['ext:aura-mimo'] },
```

没有出现在任何分组 `tabs` 里的自定义模块，会被 `navGroupOf` 默认塞进「系统」组，排在「日志」前面。

> **改模块 id 时四处必须同步**：目录名、`index.mjs` 的 `id`、`config.json` 里 `ext` 的键名、`client.js` 里的分组。少改一处，设置会丢或者标签消失。

> **风险**：`client.js` 在 `node_modules` 里，升级/重装 `dsh-aurabot-qq` 会被覆盖，需要重打补丁。

---

## 三种让她说话的方式

### 1. 她自己决定（有感知）

她有一个工具 `mimo_say`。聊天时她说「晚安」觉得很适合用声音，就会自己调用它发一条语音条。

你在 QQ 里直接说「**用语音说晚安**」就能触发。

### 2. 自动语音

面板里打开「自动挑一句话用语音说」，她每轮回复有 **30%** 概率把其中一条短句（不超过 120 字）换成语音条。

可以在面板拖滑块调概率，0 就是关闭。

> **实现注意**：自动语音不能走 `reply/items` 的 `{ kind: 'voice', value }`。
> 框架约定 voice 项的 `value` 是**要念的文字**，它会再交给内置语音引擎合成；
> 内置语音关着（`voice.enabled=false`）时更会把 `value` 直接当文字发出去。
> 所以本模块的做法是：自己合成 WAV，用 `api.sendVoiceFile()` 直接发语音条，
> 再把原文字项从 `items` 里摘掉。**永远不要把文件路径塞进 `items`。**

### 3. 手动命令

在 QQ 里发：

```
/语音 你好呀
```

只有主人能用。

---

## 面板

aurabot 面板 →「语音」标签页 → 最下面就是「MiMo 音色工坊」。

里面能：

- 看运行状态（Key 有没有填、参考音频、缓存数）
- 填 API Key、改模型、改格式、调超时
- 上传参考音频 / 从 assets 里选
- **试音间**：输入文字点「生成语音」当场听
- **发一条语音自检**：真发到主人私聊，验证整条链路
- 调语音概率和最长字数

改完记得点「保存设置」。

---

## 关键技术点

### MiMo 的调用方式

MoMo 的 TTS 接口是伪装成 `chat/completions` 的：

```js
{
  model: 'mimo-v2.5-tts-voiceclone',
  messages: [{ role: 'assistant', content: '<style>温柔</style>要念的文字' }],
  audio: { format: 'wav', voice: 'data:audio/mpeg;base64,...' }
}
```

参考音频以 **data URI** 塞进 `audio.voice`，返回的音频在 `choices[0].message.audio.data`（base64）。

### 性能优化（实测）

第一版没做优化时，单次试音要 **86 秒**。分析后定位：

- base64 编码参考音频：2 ms（不是瓶颈）
- 网络连接：0.5 s
- **MiMo 服务端生成：剩下全部**

也就是慢在对方，不在本地。但做了三处改进：

1. **参考音频按体积升序** —— 自动选最小的预设（170 KB 而不是 316 KB），请求体小一半
2. **结果缓存 10 分钟** —— 同一句话重复请求直接返回，实测 **0.004 秒**
3. **并发去重** —— 同一句话正在合成时，后来的请求复用那次结果，不会并发打两次 API

实测速度在 2～90 秒之间波动（取决于 MiMo 当时排队情况），所以默认超时设成了 **180 秒**。

### 设置写入的一个坑

`api.settings()` 只在模块启动时读一次配置文件。我从宿主直接改 `config.json` 后，模块内存里还是空值。

正确的做法是走 `api.saveSettings()`，所以加了个 `/save` 路由专门干这事。面板保存也走它，不依赖面板注入的 `setSettings`（实测那个没把值写进去）。

---

## 功能清单

| 功能 | 说明 |
|---|---|
| 音色克隆 | `mimo_say` 工具 + 自动语音 |
| 配置面板 | panel.js 面板 |
| 参考音频 | 支持上传（落在 `dataDir/ref/`），也可把文件放进 `assets/` |
| 预设切换 | ✅ |
| 试音间 | ✅ |
| 一键自检 | `发一条语音自检`（真发送） |
| 选了 MP3 会自动改用 WAV 合成（不依赖 ffmpeg） | ✅ |
| `<style>` 风格提示 | ✅ |
| `voicedesign` 文字造音色 | ✅ |
| pcm16 自动封装 WAV | ✅ |
| 错误码中文提示 | ✅ |
| 参考音频 mtime 缓存 | ✅ |

---

## 已知限制

1. **合成慢**：MiMo 单次要 2～90 秒，波动大。自动语音模式下如果她刚好挑中一句话，那条回复会明显延迟。介意的话把概率调低或者关掉。

2. **参考音频每次全量上传**：`audio.voice` 是完整 data URI，170 KB 的音频变成约 227 KB 请求体。用更大的音频会更慢。

3. **选了 MP3 会多花一次调用**：MP3 发出去不一定能当语音条，所以会重新按 WAV 合成一遍。

4. **自动语音一次只换一条**：避免一轮回复里出现好几条语音轰炸。而且只换**第一条**——语音是立刻发出去的，换中间那条会让聊天顺序错乱。

5. **自动语音和内置语音互不影响**：本模块直接发语音文件，不需要打开内置 `voice` 模块。

---

## 完全接管语音（进阶用法，可选）

### 先分清两种状态

| 状态 | 谁在念 | MiMo 生效的地方 |
|---|---|---|
| **默认（并存）** | 内置 `voice` 念所有的 | 只有 `mimo_say` 工具、自动语音、`/语音` 命令 |
| **完全接管（替换）** | 全由 MiMo 念 | **她所有的语音条**，包括内置语音功能触发的那些 |

想让"她的每一句语音都是自己的声音"，才需要做下面这一步。不做也完全能用。

### 为什么能替换

内置 `voice` 的源码开头写着：

> 导出 `speak(text)` → `{ file, engine }`：聊天中枢发语音时找它。
> **替换这个模块就能换成任何你想要的念法。**

聊天中枢发语音条时调的是 `api.use('voice').speak(text)`。
本模块实现了同一个接口（`setup()` 返回 `{ speak }`），所以只要"变成 voice"，
它就会被自动调用 —— 这是 Aurabot 官方留的口子，不是 hack。

### 怎么做（一步）

```bash
cd <dsh 数据目录>/plugins-data/aurabot/modules
mv aura-mimo voice
```

Windows PowerShell：

```powershell
Rename-Item '<dsh 数据目录>\plugins-data\aurabot\modules\aura-mimo' 'voice'
```

**只改文件夹名就够了。** 模块 id 取自文件夹名，改完自动对上，不用动任何文件
（`module.json` 里的 `id` 写的是什么都不影响）。

改完重启 DSH，或等它 3 秒内自动重载。

### 怎么确认真的接管了

**① 日志（最快）**

`<dsh 数据目录>/plugins-data/aurabot/logs/` 下最新的 `.log` 里应该有：

```
[modules] 模块「voice」（自己写的）已启动
```

出现下面任何一条就是**没成功**：

| 日志 | 原因 |
|---|---|
| `模块 id「...」要和文件夹名「...」一样` | 用的是 1.1.0 或更早，升级到 1.1.1 |
| `模块「aura-mimo」...已启动` | 文件夹没改成 voice |
| 完全没有 voice 相关行 | DSH 没重载，真正重启一次 |

**② 模块列表**

面板 → 模块，或访问 `http://127.0.0.1:6180/aurabot/api/modules`：

```json
{ "id": "voice", "running": "user", "userDir": ".../modules/voice", "builtin": true }
```

关键：`running` 必须是 **`user`**。如果是 `builtin`，说明还在跑内置的。

**③ 实际听**

填好 API Key、上传参考音频，在 QQ 里让她说句话。
语音条的**音色应该是 MiMo 的**，而不是原来内置 TTS 的声音。

### 代价（务必先看）

| 项目 | 说明 |
|---|---|
| **语音识别会消失** | 内置 `voice` 还带 `/voice/asr-status`、`/voice/asr-prepare`、`/voice/asr-last`、`/voice/asr-test`（听语音转文字）和 `/voice/install`（音色安装）。本模块没有这些功能，替换后一起没了 |
| **配置要重填** | 配置按模块 id 存，`aura-mimo` 和 `voice` 是两份。原来填的 API Key 不会跟过来 |
| **参考音频要重传** | 数据目录也按 id 分：落在 `modules-data/<id>/ref/`，改名后目录变了 |

**要用语音识别就别做这一步。** 默认的三种入口已经够用。

### 改回去

```bash
mv voice aura-mimo
```

内置 `voice` 会自动回来。原来的配置也还在（`modules-data/aura-mimo/` 没动过）。

> 顺带说明：1.1.1 之前（1.1.0）改完名会出现"面板消失"——那是从 `module.json`
> 读 id 导致加载失败、回退内置 voice 的 bug，1.1.1 已改成用文件夹名，不会再有。
## 配置项

| 键 | 默认 | 说明 |
|---|---|---|
| `apiKey` | 空 | MiMo API Key |
| `apiBase` | `https://api.xiaomimimo.com/v1` | 接口地址 |
| `model` | `mimo-v2.5-tts-voiceclone` | 也可选 `voicedesign` |
| `format` | `wav` | wav / mp3 / pcm16 |
| `stylePrompt` | 空 | 语气控制，作为 `<style>` 前缀 |
| `seedText` | 空 | 对话上下文，稳定音色 |
| `timeout` | 180 | 秒 |
| `autoVoice` | true | 自动挑话说语音 |
| `voiceChance` | 0.3 | 概率 0~1 |
| `maxChars` | 120 | 自动语音改写的最大字数 |
