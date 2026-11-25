# 换耳朵、换嘴巴（语音适配说明）

这个模块的语音分两头，都可以单独换，不用改一行代码：

| 叫法 | 作用 | 设置项 |
|---|---|---|
| **耳朵** | 把你说的话转成文字（STT / ASR） | `asrProvider` 及 `asr*` 系列 |
| **嘴巴** | 把她要说的文字合成声音（TTS） | `ttsProvider` 及 `tts*` 系列 |

设置位置：面板 → 通话 → 设置区（自动表单，改完点保存，模块 3 秒内热生效）。

---

## 一、先搞清楚你有哪几类服务

拿到一个语音平台，先判断它属于哪一类，对应关系就定了：

| 平台形态 | 用哪个 provider | 要填什么 |
|---|---|---|
| 自家电脑上跑的服务（faster-whisper、GPT-SoVITS、CosyVoice、FunASR…） | `local` / `gptsovits` / `cosyvoice` | 地址，多半不用密钥 |
| 接口长得像 OpenAI（路径是 `/v1/audio/transcriptions`、`/v1/audio/speech`） | `openai` | 地址 + Key + 模型名 |
| 别的形状（自家签名、要传 base64、返回 JSON 套娃） | `http` | 一段 JSON 模板 |

**先试 `openai`，接不上再写 `http` 模板**——九成线上服务的兼容层都是 OpenAI 形状。

---

## 二、耳朵（语音识别）

### `local`：本地 faster-whisper（默认）

| 项 | 填法 |
|---|---|
| `asrUrl` | 留空 = `http://127.0.0.1:8000`；换机器/换端口才填 |
| `asrModel` | 留空用服务自己的模型；也可填 `small` / `medium` |
| `asrKey` | 不用填 |

要求对端提供两个路径：`GET /health`（返回 `{"ok":true,"model":"small","device":"cuda"}`）和 `POST /v1/audio/transcriptions`（multipart，字段 `file`，可选 `model`、`language`）。

### `openai`：任意 OpenAI 兼容转写

| 项 | 填法 |
|---|---|
| `asrUrl` | 填到 `/v1` 为止，或直接填完整的 `/audio/transcriptions`。本地留空无效，必须填 |
| `asrKey` | 平台给的 Key（`password` 类型，日志自动打码） |
| `asrModel` | **必填**，各平台不一样，见下表 |
| `asrLang` | `zh`；不填默认 zh |
| `asrPrompt` | 可选。热词/上下文，把名字、地名、行话写进去能明显少错字 |

已知填法（其余平台按"地址到 /v1 + 模型名"同理）：

| 平台 | `asrUrl` | `asrModel` |
|---|---|---|
| OpenAI | `https://api.openai.com/v1` | `whisper-1` 或 `gpt-4o-transcribe` |
| Groq | `https://api.groq.com/openai/v1` | `whisper-large-v3-turbo` |
| 硅基流动 | `https://api.siliconflow.cn/v1` | `FunAudioLLM/SenseVoiceSmall` |
| 火山方舟 | 填**完整**端点（形如 `https://ark.cn-beijing.volces.com/api/v3/audio/transcriptions`），因为它不是 `/v1` | 方舟上的推理接入点 ID |

> 地址规则：以 `/v1` 结尾就自动补 `/audio/transcriptions`；已经写了完整端点就原样用；其它（如 `/api/v3`）**必须自己写全**。

### `http`：自定义模板

`asrTemplate` 填 JSON。三种传音频的方式，按平台要求选一个：

```jsonc
// ① multipart（最像 OpenAI，但字段名/路径不一样）
{
  "url": "https://example.com/asr",
  "method": "POST",
  "headers": { "Authorization": "Bearer xxx" },
  "mode": "multipart",
  "audioField": "audio",              // 平台要求的文件字段名
  "filename": "speech.wav",
  "fields": { "lang": "zh", "format": "wav" },   // 额外表单字段
  "textPath": "result.text"           // 从返回 JSON 里取文本
}

// ② base64 塞进 JSON（国内平台常见）
{
  "url": "https://example.com/asr",
  "method": "POST",
  "headers": { "X-Api-Key": "xxx" },
  "mode": "base64",
  "body": "{\"audio\":\"{audio_b64}\",\"lang\":\"zh\",\"reqid\":\"{reqid}\"}",
  "textPath": "data.result[0].text"
}

// ③ 裸二进制直接 POST
{
  "url": "https://example.com/asr",
  "method": "POST",
  "headers": { "Content-Type": "audio/wav", "X-Token": "xxx" },
  "mode": "raw",
  "textPath": "text"
}
```

字段说明：

- `mode`：`multipart`（默认）/ `base64` / `raw`
- `body` 占位符：`{audio_b64}` 音频 base64、`{reqid}` 随机 UUID
- `textPath`：支持 `a.b`、`data.result[0].text` 这种路径；返回不是 JSON（纯文本）时直接当文本用
- `fields`：只对 multipart 生效，值会原样作为表单字段

---

## 三、嘴巴（语音合成）

### `follow`：跟随「语音」页（默认）

不改任何东西，用插件全局 `voice.engine`。老配置升级后行为完全不变。

### `gptsovits`：本地 GPT-SoVITS（首句最快）

地址、参考音、参考文本都在「语音」页配（参考音 3–10 秒，参考文本必须跟录音逐字一致，否则合成会漏字）。这里只需要 `ttsProvider=gptsovits`；`ttsUrl` 想覆盖地址时才填。

**流式**：走 `/tts?streaming_mode=true`，首包 0.5–1 秒就能出声。这是目前延迟最低的一条路。

### `cosyvoice`：本地 CosyVoice

用「语音」页里的 `voice.cosyvoice`（地址、mode、spkId）。

### `edge`：微软 edge-tts（线上、免费）

`ttsVoice` 填音色，如 `zh-CN-XiaoxiaoNeural`、`zh-CN-YunxiNeural`；`ttsSpeed` 填 `+10%` 这种。要插件里装过 edge-tts（「语音」页有一键装）。

### `openai`：任意 OpenAI 兼容 `/audio/speech`

| 项 | 填法 |
|---|---|
| `ttsUrl` | 到 `/v1` 为止，或完整 `/audio/speech` |
| `ttsKey` | 平台 Key |
| `ttsModel` | 如 `tts-1`、`gpt-4o-mini-tts` |
| `ttsVoice` | 音色名，**各平台差异最大的一项** |
| `ttsFormat` | `pcm`（默认，能边合成边播，最快）/ `mp3` / `wav` |
| `ttsSampleRate` | 只有 `pcm` 用到；不确定按平台文档填，多数是 24000 |
| `ttsSpeed` | 0.5–2 的数字 |

已知填法：

| 平台 | `ttsUrl` | `ttsModel` | `ttsVoice` |
|---|---|---|---|
| OpenAI | `https://api.openai.com/v1` | `tts-1` / `gpt-4o-mini-tts` | `alloy`、`nova`、`shimmer`… |
| 硅基流动 | `https://api.siliconflow.cn/v1` | `FunAudioLLM/CosyVoice2-0.5B` | `FunAudioLLM/CosyVoice2-0.5B:alex` 这种「模型:音色」 |
| 火山 / 阿里 / MiniMax | 各家的地址不是 `/v1` 结尾，**用 `http` 模板更省事** | | |

> `pcm` 分支会在流前面自动补一个 WAV 头（长度写未知，浏览器认），所以页面能边下边播。

### `http`：自定义模板

`ttsTemplate` 填 JSON：

```jsonc
// ① GET，文本放地址里（少数服务这样）
{
  "url": "https://example.com/tts?text={text}&voice=xxx",
  "method": "GET",
  "headers": { "X-Token": "xxx" }
}

// ② POST JSON，返回二进制音频
{
  "url": "https://example.com/tts",
  "method": "POST",
  "headers": { "Authorization": "Bearer xxx" },
  "body": "{\"text\":\"{text}\",\"voice_id\":\"xxx\",\"format\":\"mp3\"}",
  "format": "mp3"
}

// ③ POST JSON，返回 JSON 里套 base64（国内平台常见）
{
  "url": "https://example.com/tts",
  "method": "POST",
  "headers": { "Authorization": "Bearer xxx" },
  "body": "{\"text\":\"{text}\",\"model\":\"xxx\"}",
  "audioPath": "data.audio",     // 取音频的路径，会自动去掉 data:audio/...;base64, 前缀
  "format": "wav"
}
```

字段说明：

- 占位符：`{text}`（JSON 转义过的文本）、`{text_raw}`（原文）、`{reqid}`
- `audioPath`：返回 JSON 时从这里取 base64；会自动尝试 `data.audio`、`audio`、`data`
- `format`：`mp3` / `wav` / `ogg` / `m4a` / `aac` / `flac`；不填会嗅探文件头

---

## 四、失败会怎样（重要）

**不会没声音，只会换人念。** 降级链是：

```
gptsovits → edge → windows
cosyvoice → edge → windows
openai   → edge → windows
http     → edge → windows
edge     → windows
```

- 每一次降级都会在日志里写一行 `xxx 合成失败：原因`，排查时先看日志
- 耳朵（识别）**不降级**：识别不出来就明确告诉你"没听清"，不会偷偷换平台
- 中途断流（已开始播了才失败）没法换，只会提前结束这一句

---

## 五、换完怎么验

不用开手机，浏览器/命令行就能验：

```bash
B=http://127.0.0.1:<Aurabot端口>/aurabot/api/ext/voicecall

# 1. 两边状态（推荐先看这个）
curl -s $B/state
#   asr.ready / asr.provider / asr.why   ← 耳朵
#   mouth.ready / mouth.provider / mouth.why ← 嘴巴

# 2. 只测嘴
curl -s -o test.wav -w "%{http_code} ttfb=%{time_starttransfer}s\n" "$B/say?text=你好呀"
#   看响应头 X-Voice-Provider，能确认实际用了哪家

# 3. 只测耳朵（16k 单声道 WAV）
curl -s -X POST -H "Content-Type: audio/wav" --data-binary @test.wav $B/turn
```

端口在面板 URL 里（每次启动可能不同）。局域网手机走 `https://<电脑IP>:8443/...`，配置同样生效。

---

## 六、几个容易踩的坑

1. **换引擎后第一通电话有点慢**：垫话缓存要按新音色重做（4 句）。设置一改，旧的自动清空，日志会出现"垫话缓存清空重做"。
2. **音色不对/听起来不是她**：先看 `X-Voice-Provider` 是不是你以为的那家（可能在降级）。
3. **首句慢**：优先选能流式的（`gptsovits`、`openai` + `pcm`）。整段返回的服务（edge、多数 `http`）必须等整段合成完才出第一声，长句会明显卡。
4. **费用**：`openai`/`http` 这类按字符计费，电话里每句都会调一次（按句子切分），比打字聊天贵得多，注意额度。
5. **密钥安全**：`asrKey`/`ttsKey` 是 `password` 类型，面板不回显，日志里会自动打码。
6. **只想自己用不花钱**：保持 `asrProvider=local` + `ttsProvider=follow`，本机跑 faster-whisper 和 GPT-SoVITS，零成本。
