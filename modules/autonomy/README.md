# 自主生活 · autonomy

给 [Aurabot](https://github.com/aureth-labs/dsh-aurabot-qq)（DSH 的 QQ 插件）用的模块：**让 AI 角色自己决定什么时候醒、醒来做什么**，而不是只在被叫的时候才回应。

> 本仓库是一个独立模块，**不属于** Aurabot 主仓库，也不含主插件任何代码。

---

## 它解决什么问题

没有这个模块，角色是纯被动的：你不发消息，她就不存在。聊天框一关，她的一天就断了。

装上之后，她有了一条自己的时间线：

```
06:20  醒 → 接着搭昨天那个日志分析工具，能按日期筛了
09:45  醒 → 刷了会儿 B站，记下三个想看的纪录片
14:10  醒 → 手机刷了会儿 B 站，看到一个讲编译原理的
18:30  醒 → 歇着（下次醒自动推迟两小时）
```

**这些都不是你让她做的**，是她自己排的时间、自己挑的事。

## 核心机制

### 1. 自己排下一次醒来的时间

```
间隔 = 随机(最短, 最长) × 时段活跃度倍率
```

活跃度表可以自己配，比如：

```
07-12=0.8    早上活跃，间隔打八折，更常醒
12-14=1.6    午休安静，间隔拉长
18-23=0.6    傍晚最活跃
23-24=1.4    夜里收敛
```

她还会读这个倍率来**决定这一轮干多大**：倍率低（最活跃）时干大的，倍率高（低谷）时做轻的。

### 2. 醒来后自己决定做什么

动作名不设限，模型可以自己起中文名——「续搭进度台」「研究一下 systemd」「整理昨天的笔记」都行。认识的动作走内置通道，不认识的用 `detail` 里的命令直接落地。

### 3. 硬约束：防止「自主」变成混日子

这是这个模块真正下功夫的地方。提示词里写了五条铁规：

| 规则 | 内容 |
|---|---|
| **禁止发呆** | 每次醒来必须做具体的事，「想不出大事就做小事」 |
| **反重复** | 同一动作一天最多 **5 次**。「翻一遍、再翻一遍、又翻一遍不是生活，是卡带」 |
| **反空想** | `think` 有每日上限；上一次只想没做，这一轮直接禁掉 think |
| **反软** | 日常琐事一天最多 **60 次**，剩下的时间必须去学一件或造一件 |
| **判据** | 「做完明天还能接着用」才算正经事，看一眼就没的不算 |

而且会追进度，不会每次从零开始：

```
你手上在弄：日志分析小工具——上次做到能按日期筛了
```

### 4. 有人格、有心情、有记忆

- 读人格卡的 **MBTI**，不同型有不同语气和偏好动作（INFP 偏爱写日记和思考，ESTP 偏爱动手折腾）
- 读 `mood` 模块的当前心情，写进这一轮提示词
- 从 `memory` 记忆库挑 6 条，让她醒来能接上之前的事
- 留一句话给下次的自己：「明天试试用 awk 重写这段」

---

## 她能做什么

| 动作 | 干什么 | 依赖 | 没有时的表现 |
|---|---|---|---|
| `bili` | 刷 B 站 | `bili` 模块 ✅ 内置 | 跳过 |
| `diary` | 写日记 | `diary` 模块 ✅ 内置 | 跳过 |
| `draw` | 画一张图 | `imagegen` 模块 ✅ 内置（需配生图服务） | 跳过 |
| `speak` | 主动说句话 | `speakup` 模块 ✅ 内置 | 跳过 |
| `phone` | 手机签到、浏览、点赞 | `phone` 模块 ⚠️ **需另外装** + adb | 跳过 |
| `think` | 纯思考（每天有上限） | 无 | 一直可用 |
| `rest` | 歇着，自动推迟下次醒 | 无 | 一直可用 |

**跳过 = 静默略过，不报错**。缺哪个模块她就少一种玩法，程序照常跑。

---

## 配套模块：让功能更完整

零件装得越全，她醒来越有事情可做。按重要程度列：

### ✅ Aurabot 自带（装完主插件就有，什么都不用做）

| 模块 | 给 "自主生活" 补上什么 |
|---|---|
| `memory` | **最重要**。她能想起来昨天在想什么、在搭什么，不是每次重新开始 |
| `mood` | 心情会影响语气和节奏，醒来时的心情是真的在变 |
| `bili` | `bili` 动作——自己去刷视频，回来能聊 |
| `diary` | `diary` 动作——自己写日记，不用你提醒 |
| `speakup` | `speak` 动作——没人问也主动说一句 |
| `imagegen` | `draw` 动作——自己画图（要在面板配好生图服务） |
| `qzone-social` | 让她做的事能落到 QQ 空间，不只是留在本地 |

### ⚠️ 需要另外安装

| 模块 | 给 "自主生活" 补上什么 | 从哪拿 |
|---|---|---|
| `phone` | `phone` 动作——玩你那台安卓手机：签到、浏览、点赞 | [社区模块仓库](https://github.com/aureth-labs/dsh-aurabot-qq-mods) |

### 🔧 自备

| 项 | 用处 |
|---|---|
| 安卓手机 + `adb` | 配合 `phone` 模块使用 |
| 生图服务 | `draw` 动作需要，Aurabot 面板「生图」页配置 |

### 只装这一个模块会怎样

- ✅ 排程、决策、状态、面板、日志全部正常
- ✅ `think` / `rest` 一直可用
- ⚠️ 其余动作静默跳过，她会明显「安静」下来

**结论**：只装它也完全能用，但配上 `memory` + `mood` + `phone`，才像真的在过日子。

---

## 需要的环境

| 项 | 要求 |
|---|---|
| Aurabot 插件 | `>= 1.2.0`（模块 API v1） |
| Node.js | `>= 22.13.0` |
| 安卓手机（可选） | 装了 `adb` 且开了 USB 调试，配合 `phone` 模块 |
| 模型 | 任意 Aurabot 可用的模型；决策用的是一次纯文本调用 |

**只配手机也能跑**：没配手机时就只在状态里想事情、写计划，不会去动任何机器。

## 安装

```bash
cd <你的 DSH_HOME>/plugins-data/aurabot/modules
git clone https://github.com/asyncxt/aurabot-mod-autonomy.git _tmp
mv _tmp/modules/autonomy ./autonomy
rm -rf _tmp
```

或者直接把 `modules/autonomy/` 整个目录拷到 `plugins-data/aurabot/modules/` 下面。

放好之后在 Aurabot 面板 →「模块」里应该能看到「自主生活」，重启 DSH 或等模块热重载即可。

## 配置

面板 →「自主生活」页，或直接改 `config.ext.autonomy`。

| 键 | 说明 | 默认 |
|---|---|---|
| `enabled` | 总开关 | `false`（装上不自己动，要手动打开） |
| `grants` | 能力授权：`model`（调模型决策）、`phone`（操作手机） | 全 `false` |
| `allowNewMod` | 允许她给自己写新模块 | `false` |
| `askTimeoutSec` | 决策调用超时（秒） | `45` |
| `minInterval` / `maxInterval` | 两次醒来的间隔区间（分钟） | `20` / `90` |
| `maxWakesPerDay` | 每天最多醒几次 | `40` |
| `awakeFrom` / `awakeTo` | 活跃时段（小时，写 `24` 表示到半夜） | `7` / `24` |
| `activityTable` | 时段活跃度，每行 `HH-HH=倍率`，`<1` 更活跃 | `07-12=0.8 …` |
| `phoneLock` | 手机锁屏密码，玩手机时自动输入，留空表示不锁屏 | `''` |
| `phoneMaxPerDay` | 手机每天最多逛几次 | `100` |
| `moodNote` | 写进提示词的倾向描述（比如想让她多玩手机） | `''` |
| `playfulness` | 调皮程度 `low` / `medium` / `high` | `medium` |

### 手机怎么配

需要 [`phone` 模块](https://github.com/aureth-labs/dsh-aurabot-qq-mods)提供 `adb`。没装 `phone` 模块时，手机相关的动作会被跳过。

## 命令

```
/自主          看当前状态（开没开、今天醒了几次、下次什么时候）
/自主 开       打开
/自主 关       关掉
/自主 10       每天最多醒 10 次
```

## 数据写到哪

| 文件 | 内容 |
|---|---|
| `<dataDir>/autonomy.json` | 当天状态：醒来次数、下次时间、计划、做过的动作、项目进度 |
| `<dataDir>/activity.jsonl` | 每次活动的流水（追加写，按天滚动） |

`dataDir` 由 Aurabot 提供，通常是 `plugins-data/aurabot/modules-data/autonomy/`。

## 安全

这个版本**默认一项能力都没有**：`module.json` 的 `capabilities` 是空数组，代码里也没有任何默认可用的外部能力。

### 逐项授权（默认全关）

装上之后她**什么都不能干**，只能发呆、想事情、歇着。要用哪一项，在主人在面板 →「权限」里一项一项手动打开：

| 授权项 | 对应声明 | 打开后能做什么 | 风险 |
|---|---|---|---|
| 调用模型做决策 | `plugin-internals` | 每轮问她「现在想做什么」——不开这项她不会做任何决定 | 中 |
| 操作连着的那台手机 | `process` | 通过 adb 查电量/锁屏、模拟点击、写手机日记 | 高 |

没授权时：`wake()` 直接返回「还没授权」，**根本不会去碰宿主模型**；`runAdb()` 直接返回失败，**一条 adb 命令都不会执行**。

`capabilities` 写空、`grants` 默认全 `false`、代码里处处先查 `isGranted()`——三处对齐，不会出现「声明说不用、代码偷偷用」。

### 命令白名单

不连接任何远端主机。所有外部命令都必须过白名单闸门（`lib/exec-guard.mjs`）。

### 命令白名单

只有两组调用，规则写在 `lib/exec-guard.mjs`，测试逐条钉死：

| 可执行文件 | 允许的形态 | 用途 |
|---|---|---|
| `adb` | `devices` / `start-server` / `shell dumpsys` / `shell input` / `shell settings` / `shell am` / `shell pm` / `shell screencap` / `shell ls\|cat\|mkdir\|printf\|base64\|date` / `push` / `pull` | 手机状态查询与操作 |
| `node` | `--check <文件>` | 校验她自写模块的语法 |

白名单**之外的一切都拒绝**：`shell su`、`shell sh`、`install`、`uninstall`、`root`、`remount`、`forward`、以及任何别的可执行文件（bash / sh / powershell / python / curl / ssh…）。

### 危险命令清单

即使将来白名单放宽，命中下面这类模式也一律拒绝（`DANGEROUS`，27 条）：

- 破坏性：`rm -rf`、`mkfs`、`dd of=/dev/*`、`shred`、`wipefs`、`> /dev/sd*`
- 关机/杀进程：`shutdown`、`reboot`、`halt`、`poweroff`、`kill -9 -1`
- 提权/改账户：`sudo`、`su`、`useradd`、`passwd`、`chmod 777 /`、`chmod +s`
- 远端执行：`curl … | sh`、`wget … | bash`、`eval`、`nc -e`、`/dev/tcp/`
- 系统配置：`iptables`、`sysctl`、`insmod`、`crontab -r`
- 远端连接：`ssh`、`scp`、`sftp`（这个版本本就不该出现，兜底一层）

### 另外几条边界

- **不走 shell**：只传「可执行文件 + 参数数组」，参数里出现 `;&|\`$(){}<>` 或换行一律拒绝，所以拼接在结构上就无效。
- **模型文本永不进参数**：`detail` / `steps` / `action` 只当「想做什么」的描述记录，有 `assertNoModelText()` 兜着，进了参数当场抛错。
- **默认关闭**：`enabled` 默认 `false`，装上不会自己动。
- **只认主人**：`/自主` 显式校验 `api.isOwner(userId)`，非主人拿到空回复且日志留痕。
- **超时真取消**：决策调用默认 45 秒超时（`askTimeoutSec` 可调），超时用 `AbortController` **中止底层流**，不是只停止等待。
- **失败即降级**：模型报错、超时、返回解析不了的内容，都只让这一轮歇着，不抛异常、不重试成风暴。
- **密码不进日志**：手机锁屏密码是 `password` 类型，日志和活动流水里都不会出现。

### 她给自己写模块（newmod）

这是本模块里唯一能让模型**间接影响代码**的入口，所以两道闸：

1. **默认关闭**：`allowNewMod` 默认 `false`，不打开她根本不会写文件
2. **静态闸门**（`lib/mod-scan.mjs`）：打开之后写出来的代码还要过扫描——
   禁起子进程、禁直连网络（含 `fetch`）、禁 `eval`/`new Function`、禁用 `api.core`/`api.lib`/`api.dsh`、
   禁删除/改权限/改属主、禁写系统路径、禁路径穿越

这不是沙箱，是降低误伤的门槛；真正的边界是「默认不给它写」。

### 回归测试

| 文件 | 盯什么 |
|---|---|
| [`test/exec-guard.test.mjs`](test/exec-guard.test.mjs) | 白名单放行/拒绝逐条、27 条危险命令、shell 元字符、模型文本进参数 |
| [`test/trigger.test.mjs`](test/trigger.test.mjs) | 默认关闭、只认主人、超时真取消、失败降级、密码不进日志 |
| [`test/security.test.mjs`](test/security.test.mjs) | 源码无 `ssh`、每个 `execFile` 前都有 `checkExec`、决策解析防御 |
| [`test/mod-scan.test.mjs`](test/mod-scan.test.mjs) | newmod 默认关闭、危险代码逐个拒绝 |
| [`test/grants.test.mjs`](test/grants.test.mjs) | capabilities 为空、默认全关、没授权不碰模型/不跑 adb |

## 许可

MIT，见 [LICENSE](LICENSE)。

模块 API 由 Aurabot 提供；本模块没有复制 Aurabot 主仓库的代码。
