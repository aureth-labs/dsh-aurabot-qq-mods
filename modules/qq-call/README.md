# QQ语音通话（Aurabot 模块）

把合成的语音送进 QQ 语音通话，并自动完成一整轮对话：

```
QQ 来电 → 她自己决定接不接 → 点接听 → 抓 QQ 播出来的声音 → 识别成文字 → 大模型想好怎么回 → 合成语音 → 经虚拟声卡送进 QQ 麦克风
```

模块本身不含任何人设、聊天记录、密钥或某台机器的路径；人格、模型地址、语音引擎都从设置里读。

## 依赖

| 东西 | 说明 |
|---|---|
| Windows + Python 3.10+ | 全部脚本在 Windows 上跑，靠 WASAPI 和窗口枚举 |
| VB-CABLE 虚拟声卡 | https://vb-audio.com/Cable/ ，装完会有 `CABLE Input`（播放）和 `CABLE Output`（录音）两个端点 |
| ffmpeg | 云端 mp3 要它转 PCM，必须在 PATH 里 |
| Python 包 | `pip install -r runtime/requirements.txt` |
| 模型 | **不进安装包**（85 MB 会被安装器拒收）。放到 `plugins-data/aurabot/modules-data/qq-call/runtime/models/`，下载见下面「模型」一节 |

## 模型（第一次装完要手动放一次）

安装包里只有代码，没有模型。装好后把下面两组文件放进
`~/.dsh/plugins-data/aurabot/modules-data/qq-call/runtime/models/`（面板会提示缺哪几个）：

```
models/
├─ zh_CN-huayan-medium.onnx          # Piper 中文女声（引擎=piper 时用）
├─ zh_CN-huayan-medium.onnx.json
└─ sherpa-zh/
   ├─ encoder-epoch-99-avg-1.int8.onnx
   ├─ decoder-epoch-99-avg-1.onnx
   ├─ joiner-epoch-99-avg-1.int8.onnx
   └─ tokens.txt
```

- Piper：`rhasspy/piper-voices` 里的中文女声 `zh_CN/huayan/medium`。
  国内拉不动 huggingface 就用镜像，把域名换成 `hf-mirror.com` 即可
  （`.../zh/zh_CN/huayan/medium/zh_CN-huayan-medium.onnx` 与同名 `.json`，共约 63 MB）。
- sherpa 流式识别：`k2-fsa/sherpa-onnx` 的 `asr-models` release 里
  `sherpa-onnx-streaming-zipformer-zh-14M-2023-02-23.tar.bz2`（约 74 MB），
  解开后把 `encoder / decoder / joiner / tokens.txt` 放进 `models/sherpa-zh/`。
  包里是 fp32 与 int8 两套，本模块用 int8 的 `encoder`、`joiner` 和 fp32 的 `decoder`。

缺文件不会崩：面板「通话链路」下面会写清楚缺哪几个，日志里也有一次提示；补齐后点「全部启动」。


## 装进 Aurabot

1. 面板「扩展 → 模块市场」里搜「QQ语音通话」装上（或把 `qq-call/` 整个文件夹放到
   `~/.dsh/plugins-data/aurabot/modules/qq-call/`，文件夹名必须等于 `qq-call`）
2. 面板几秒内会自动加载，模块列表里出现「QQ语音通话」
3. 先按上面「模型」一节把模型放好，再启动
4. 在模块设置里填：Python 解释器路径（默认 `python`）、对话模型接口与模型名
5. 打开面板（模块自己的页面），点「全部启动」

运行时代码由模块首次启动时从模块文件夹铺到 `modules-data/qq-call/runtime/`：
内容一样就跳过；不一样就覆盖，覆盖前先把旧版存成 `.bak-<旧版本>/`（自己改过的调试版本也找得回来）。

运行时的数据都在 `plugins-data/aurabot/modules-data/qq-call/`：
- `runtime/` 脚本（首次启动自动从模块目录铺过来，避免模块升级时被动）、`models/`（自己放进去的模型）
- `logs/` 三个子进程的日志（bridge / loop / answer）
- `run/` pid 文件，用来认领进程，避免重复拉起

> 注意：这个模块的 Python 进程工作目录是 `modules-data/qq-call/runtime`，所以模型、`out/` 都在那里，不在模块文件夹里。

## QQ 那边要设的两处

1. 系统默认**录音设备**设成 `CABLE Output` —— 这样 QQ 才听得到合成的声音
2. 系统默认**播放设备**保持你平时的耳机 —— 回路从默认扬声器抓 QQ 播出的声音

平时要用真麦克风聊天时记得把默认录音切回来，或干脆把模块停掉。

## 面板

- **通话链路状态**：桥接、听与说、自动接听三个灯 + 全部启动 / 重启生效 / 全部停止 / 刷新
- **通话设置**：启用、自动接听、接不接这通电话（她自己决定 / 总是接 / 一律不接）、模型没回时的兜底、催话、语音引擎、兜底开场白、先听后说、安静多少秒
- **往通话里说一句**：手动推一句、推开场白、3 秒测试音

模块接口（面板和脚本都能调）：`/aurabot/api/ext/qq-call/status | start | restart | stop | say?text= | tone | greet`

## 她要不要接这通电话

默认不是「来电就点接听」，而是先问她自己。接听进程（`auto_answer.py`）认出绿色接听键后，把这几样交给对话模型：

- 来电人：从来电窗标题里抠出来的昵称（抠不出来就是「未知号码」）
- 现在几点（早上 / 中午 / 晚上…）
- 她当前的人格（`runtime/out/persona.txt`）
- 这个人最近几次打来她接没接（`runtime/out/calls.jsonl`，本地自己记的，不外传）

要她只回一行：`接` / `不接` / `等N`（N 是秒数，最多 5）；想留理由就写成 `接｜想你了`。

- 一通电话只问一次，答案按窗口记住；她说不接就不点，电话自己响完
- 她说「等N」就真的等，到点了电话还在响才接
- 模型 3 秒不回、接口不通、回的话看不懂 → 走兜底：默认「先接上」，可以在面板改成「先不接」
- 每次判断都追加到 `modules-data/qq-call/runtime/out/calls.jsonl`，最近一次另外写进 `last_decision.json`，面板「通话设置」下面直接显示「最近一次：几点、谁、她接了没有」

不想让她决定，面板里可以换成 `总是接`（模块原来的行为）或 `一律不接`（只记下来电，不点接听）。

## 接通之后的行为

1. 接通瞬间她自己决定：现编一句开口，或只回「安静」表示先只听不说
2. 她选了安静：对方 `silentOpenSec`（默认 30 秒）不出声，她就先递一句——先判断对方是想有人陪还是需要安慰，再挑一种说
3. 对方开过口之后才有「催话」（默认 14 秒没动静催一句，最多三次）
4. 模型不通时：开场白从 5 句随机兜底里挑，安慰场景从 3 句里挑

如果 Aurabot 里有当前人格（`personas.current()`），模块会把它写进 `runtime/out/persona.txt`，回路拿它当 system 提示；没有就用内置的中性说话方式。

## 选模型

面板「通话设置」里有一块「对话模型（本机探测到的）」：模块会去问
`127.0.0.1:9000`（本机模型路由）、`127.0.0.1:11434`（Ollama）以及当前配置里那个接口的 `/v1/models`，
把能对话的模型列成下拉框，选中就把接口地址和模型名一起写进设置；名字带 `bge` / `embed` 的向量模型会被跳过。

- 探不到就点一次「重新探测」，或者直接在下面手填「接口地址 + 模型名」
- 换完点「重启生效」，Python 回路才会用新模型说话
- 回路读的是环境变量 `QQ_CALL_LLM_URL` / `QQ_CALL_LLM_MODEL`，由模块按设置注入

## 语音引擎

| 引擎 | 首字延迟 | 说明 |
|---|---|---|
| `piper` | 0.03~0.2 秒 | 本地，跑 `models/zh_CN-huayan-medium.onnx`，音色中性 |
| `breeze` | 3~4 秒 | 云端，需要自己填语音 id 和 key；一句一合成，非流式 |

`CALL_TTS_ENGINE` 环境变量由模块按设置注入，脚本也可以单独跑：
`python runtime/call_bridge.py say "测试一句"`。

## 测试

三块最容易出事的判断都从运行代码里抽到了 `runtime/logic.py`（纯标准库，不碰窗口、声卡、模型和网络），
生产代码用的是同一份，测试不另写一套实现：

| 覆盖 | 被测的东西 | 用例要点 |
|---|---|---|
| 来电 → 接听 / 不接 | `logic.CallGate` | 不是绿钮不点、命中才点、10 秒冷却按窗口算、自动接听关掉只观察不动手、窗口消失分「接过的结束」与「没接的错过」、结束后再来电重新落到 RINGING |
| 来电 → 她要不要接 | `logic.caller_from_title` / `parse_verdict` / `decide_answer` / `AnswerDecider` | 从窗口标题里认出昵称（认不出就是「未知号码」）、她回「接 / 不接 / 等3｜理由」都能解析、「不接」不会被「接」抢走、等几秒封顶、一通电话只问一次、等到点才接、窗口消失清掉判断、没判断时按兜底（默认接上） |
| ASR 文本 → 回复的拼接与中断 | `logic.VoiceSegmenter`、`build_messages` / `append_turn`、`idle_action` | 语音段起止、静音 600ms 收句、短于 300ms 当咳嗽丢掉、她说的时候对方插话触发打断、底噪大时门槛自动抬高、history 只带最近 6 条 / 记住后裁到 8 条、先只听不说 30 秒开口、催话最多三次 |
| runtime 子进程启动失败 / 退出码异常 | `index.mjs` 的 `classifyExit` / `failureUpdate` / `backoffMs` / `isDegraded` | 0 正常收工、信号杀掉、非 0 都算异常；连续 3 次降级且只报一次；退避 1s→3s→9s 封顶 60s；启动失败或异常退出时清 pid、记日志，`/status.runtime` 暴露失败次数、最近一次退出和降级标记 |

跑法（模块目录下）：

```
npm test                          # 两套一起：node 19 个用例 + python 54 个用例
node --test test/qq-call.test.mjs # 模块本体、运行时部署、进程降级、接听策略透传
python test/logic.test.py         # 接听闸门、她要不要接、VAD 分段、上下文拼接、静默策略
```

市场的 CI 两边都会跑：`modules/*/test/*.test.mjs` 由仓库统一执行，`npm test` 由 `package.json` 提供；
机器上没有 python3 时 Python 那半会打印跳过，不会把检查压红。测试全程不连 QQ、不开声卡、不下载模型、不写用户目录。

## 已知限制

- 纯 CPU：更高质量的方案（GPT-SoVITS 7 秒/句、RVC 2 秒音频 15 秒）进不了实时对话，有显卡再说
- 自动接听靠窗口截图找绿色接听键，QQ 界面大改可能失效
- 她要不要接靠来电窗标题认人；有些版本标题里只有号码或什么都没有，这时按「未知号码」交给她判断
- 虚拟声卡开单声道流会被按 2 倍速播放，脚本里统一开 2 声道并把单声道样本复制到左右，改代码时别退回单声道

## 目录

```
qq-call/
├─ index.mjs              模块本体：拉进程、pid 认领、接口、命令、异常退出降级
├─ panel.js               自定义面板
├─ module.json            市场发布信息
├─ package.json           只用来跑测试，模块零依赖
├─ LICENSE
├─ README.md
├─ test/
│  ├─ qq-call.test.mjs    模块本体 / 运行时部署 / 子进程降级 / 接听策略（node --test）
│  ├─ logic.test.py       接听闸门 / 她要不要接 / VAD 分段 / 上下文拼接 / 静默策略（unittest）
│  └─ run-python.mjs      找一个能用的 python 去跑上面那个
└─ runtime/
   ├─ call_bridge.py      常驻桥接：/health /say /tone，PCM 播进 CABLE Input
   ├─ call_loop.py        听 → 识别 → 大模型 → 合成 → 播回
   ├─ speak_stream.py     Piper 小句流水，支持打断
   ├─ asr.py              sherpa-onnx 流式识别
   ├─ auto_answer.py      窗口截图找接听键 + 问她要不要接（逻辑在 logic.CallGate / AnswerDecider）
   ├─ logic.py            接听闸门 / 她要不要接 / VAD 分段 / 上下文拼接 / 静默策略（纯逻辑，可单独测）
   ├─ devices.py          列设备
   └─ requirements.txt
```

模型不随包发布，放运行时的 `models/` 下（见上面「模型」一节）。
