# 小屋世界（Cabin World）· Aurabot 模块

给大肥鱼一个**会走路的身体**。她能在像素小世界里走去公园、荡秋千、钓鱼、买零食、泡汤、喂鱼；
动作由游戏判定，钱和背包记在游戏存档里，做完的事会写进她的记忆。

- 官方项目：[BabyBus2022/cabin-world](https://github.com/BabyBus2022/cabin-world)（作者 VADS，代码 MIT / 美术与文档 CC BY 4.0）
- 本模块：把桥发布的工具挂给主人（`CORE` 里 13 个，桥清单里没有的自动跳过），并转发到本机桥；另加**一键下载安装**与**一键启动**。
- **模块本体只有代码（约 260 KB），不含游戏本体**。游戏是在你点「一键安装」时，从这个模块去上游 Release 下载到 `modules-data/cabinworld/` 的；发布包里没有游戏文件，也不会替别人装好。

## 装这个模块要准备什么

| 需要 | 说明 |
|---|---|
| Windows 10/11 x64 | 游戏是 Windows 原生程序 |
| Node.js 18+ | 桥要跑在 Node 上（Aurabot 本身已经要求 22.2+，通常没问题） |
| 本模块文件夹 | 放在 Aurabot 的 `modules/cabinworld/`，保存后几秒内自动加载，不用重启 DSH |

## 第一次用（推荐：面板里一键装）

1. 打开 Aurabot 面板，找到「小屋世界」这一页（模块单独一页）。
2. 点 **一键安装**：模块会去 GitHub Release 查最新版，下载 `CabinWorld-win64.zip`（1.1 约 287 MB，解压后约 362 MB），解压到游戏目录——就是模块数据目录 `modules-data/cabinworld`（面板上没有游戏目录输入框；设置里那条旧路径只在确实有 `CabinWorld.exe` 时才生效，失效会自动回落到数据目录）。已有存档 `data\` 会保留。
3. 点 **启动小屋世界**：起桥并打开游戏。游戏窗口默认藏着，不会抢占你的桌面；想看她此刻在干嘛，点面板上的 **显示游戏窗口**。
4. 在 QQ 私聊里跟她说「你现在在哪？」试试——桥连上就能用，不用等窗口。

也可以手动装：从 [Release](https://github.com/BabyBus2022/cabin-world/releases) 下载 zip，解压到 `modules-data/cabinworld`（不要把 `CabinWorld` 多套一层），再点面板上的「刷新」，「文件」那一行就会变成「已安装」。

> **一键安装装的是什么**：装的是**上游第三方程序** Cabin World 本体（官方 Release 里的 Windows x64 游戏 + 它自带的桥），不是从网上取模块代码来执行。
> 模块只做四件事：查 Release、`fetch` 下载 zip、用 Windows 自带的 `tar.exe` 解压、复制文件（保留 `data\` 存档和桥配置）。
> 解压出来的 `start.cmd`、`update.cmd` 这类脚本模块**不会**去执行；起游戏是 `spawn` 那个 `CabinWorld.exe`，起桥是 `node bridge-host\bridge.mjs`（补丁副本，脚本在模块自己的 `lib/` 里）。
> 下载地址只认 `github.com` / `*.githubusercontent.com`。

## 她能做什么

| 工具 | 用途 |
|---|---|
| `cabin_status` | 看自己：在哪、零花钱、背包、饱腹/口渴/心情、正在做什么、天气 |
| `cabin_look` | 看身边：这一屋有什么家具、每样能怎么用、出口去哪 |
| `cabin_catalog` | 搜全世界的家具和动作（含自制），不知道哪儿有某样东西时用；支持翻页 |
| `cabin_go` | 走去某个地方（身体在游戏里真的一路走过去） |
| `cabin_use` | 用家具/东西（荡秋千、钓鱼、喂鱼、泡汤…） |
| `cabin_buy` | 去小卖部买东西（走到货架→付钱→进背包） |
| `cabin_eat` | 吃喝/使用背包里的小卖部商品；餐厅买的菜（`restaurant-` 开头）不能用它，要用 `cabin_restaurant` 的 `eat` |
| `cabin_stop` | 停下正在做的事 |
| `cabin_restaurant` | 餐厅点菜 / 自己做菜 / 端到桌边吃 / 坐下休息 |
| `cabin_sleep` | 睡觉、起床、在床上躺一会儿，或按作息问该不该睡 |
| `cabin_toolpose` | 给手上这件事换个姿势（打字、写字、画画） |
| `cabin_task` | 按 taskId 查还没做完的动作（只有返回 `status:"running"` 时才需要） |
| `cabin_process` | 把要做的事排成活动：登记、提到最前、收尾或停下；身体动作一次一件，其余排队 |

工具的参数不是手写的：启动时从桥发布的 `openai-tools.json` 读（优先副本 `bridge-host/`，其次官方 `bridge/`），上游改参数这边自动跟上；读不到才用 `lib/tools.mjs` 里的离线兜底清单（11 个：`cabin_sleep`／`cabin_toolpose` 依赖补丁，兜底清单里没有这两个）。默认只挂 `lib/tools.mjs` 里 `CORE` 那 13 个，实际挂上的 = `CORE` 与桥清单的**交集**：副本降级成未打补丁的官方桥时会少掉 `cabin_sleep`／`cabin_toolpose`（只剩 11 个），这是设计好的降级，不是坏了。上游 1.1 **没有** `cabin_arcade` 这个工具：电玩城用 `cabin_use`，机台 id 来自 `cabin_look`。

**重要规则**：只有 `status:"done"` 才算真的发生过；`running` 是「还没做完」，不要当成做完了。

## 设置

设置都在面板的折叠段里，改完点该段底下的保存按钮（几秒生效，不用重启模块）。

| 段 | 设置 | 默认 | 说明 |
|---|---|---|---|
| 自动生活 | 自动生活 / 多久一次（分钟）/ 每天最多几次 | 关 / 45 / 8 | 打开后她会在后台会话里自己活动；最小间隔 10 分钟，次数第二天重置 |
| 自动生活 | 允许她自己花钱 | 开 | 关掉后只吃背包里已有的东西，不去小卖部，也不挂 `cabin_buy` / `cabin_eat` |
| 自动生活 | 自动生活后发 QQ 告诉我（`autoLifeNotify`） | 开 | 每轮结束私聊告诉主人她做了什么；不填主人 QQ 就不发 |
| 自动生活 | 用哪个模型 / 思考强度 | 跟随 DSH 默认 / 不指定 | 只作用于 `system:cabin-life` 这条会话，不动 QQ 聊天用的模型 |
| 模块设置 | 把经历记进记忆 | 开 | 做完的动作（`result.happened`）写进她的记忆（`memory.addEvent`） |
| 模块设置 | 群聊里也能看小屋状态 | 关 | 打开后群里只挂两个只读工具，且要求这一轮说话的人全是主人 |
| 模块设置 | 每轮把当前状态塞进上下文（私聊） | 关 | 打开后每分钟刷新一次状态，聊天时她知道自己在哪（多一点 token） |
| 模块设置 | 群聊里也塞一点状态 | 关 | 群里也知道地点、在做什么、天气；不给零花钱和身体数值 |
| 桥设置 | 端口 / 启动桥时自动打开游戏 / 天气 | 18790 / 开 / 虚拟天气 | 点「保存桥设置」，再点「重启小屋世界」生效 |

游戏目录、连接信息文件、等一个动作最多多久这三项**面板上没有输入框**：游戏目录默认就是模块数据目录（`defaults.gameDir` 为空，旧路径失效自动回落），`bridge.json` 每次启动换 token 由模块自己重读（401 时强制再读一次），`waitMs` 用默认 30000 毫秒（超了返回「还没做完」，可用 `cabin_task` 查）。

## QQ 里的命令（只认主人，仅私聊）

```
/小屋            看桥和游戏状态
/小屋 去 公园    让她走过去（家 / 小卖部 / 汤屋 / 电玩城 / 餐厅 都行）
/小屋 停          停下正在做的事
/小屋 餐厅        走去餐厅（点菜要先 cabin_restaurant menu）
/小屋 电玩城      走去电玩城
/小屋 安装        一键下载并安装（约 287 MB，装好用 QQ 告诉你）
/小屋 启动        启动桥和游戏
/小屋 最近        看她最近在小屋世界做完的三件事
/小屋 名字        看小屋世界和 aurabot 各叫什么名字
/小屋 改名 大肥鱼  写进桥配置并改游戏里的名字（不用重启）
/小屋 帮          用法
```

## 权限与安全

- 工具**只在主人私聊**挂载（Aurabot 的 `level: 'full'`）。群聊和别人的私聊默认一个都不挂；
  就算打开「群聊里也能看」也只挂两个只读工具，并在执行前用 `turnSendersAllOwner(sessionId)` 再查一次。
- 桥只监听 `127.0.0.1`，每次启动换随机 token；模块只连本机，不把存档、token 发到任何外部地址。
- `/ext/*` 仅接受本机回环请求，写操作只收 POST。
- 一键安装只访问两个地址：`api.github.com`（查最新版本）和 GitHub 的 Release 下载地址。

## 游戏目录与宿主副本

游戏装在**模块数据目录**里：`modules-data/cabinworld`（插件给每个模块单独开的数据目录，删模块时默认保留，路径不写死盘符）。

桥有两份，分工明确：

| 目录 | 谁维护 | 用途 |
|---|---|---|
| `modules-data/cabinworld/bridge/` | 一键安装（整目录覆盖） | 官方参考桥，**保持原样**，不直接跑 |
| `modules-data/cabinworld/bridge-host/` | 本模块 | 官方桥的副本 + 「睡觉」「工具姿势」两类补丁（1.1 已自带餐厅/电玩城/棋盘），**实际跑的是这份** |

- 启动/重启桥时先比对整树指纹（`bridge/` 与 `lib/patches/` 下除 `data/`、`node_modules/`、`.git/`、`bridge.config.json`、`*.log`、`*.bak-*` 外所有文件的「相对路径+size+mtime」），变了才重建副本；
  早先只认 5 个固定文件，上游新增文件时副本不会重建，才改成整树。
- 重建流程：复制 → 打补丁（`lib/patches/apply.mjs --bridge <副本> --no-backup`）→ 成功才替换；补丁失败时保留旧副本并报错，不会半改；
- 副本与 `bridge/` 是兄弟目录，配置里的 `../data`、`../CabinWorld.exe` 照样成立，所以副本直接读 `bridge/bridge.config.json`（名字、端口、`dataDir` 都在那一份里）；
- 一键安装/升级覆盖 `bridge/` 不再影响高级功能，**装完不用再手动跑 `apply.mjs`**；
- 从旧版本升级：早期版本把游戏装在 `D:\CabinWorld`，随后搬进模块目录，现在统一放在 `modules-data/cabinworld/`。模块的 `gameDir()` 只在设置里那条路径确实有 `CabinWorld.exe` 时才用它，旧路径失效会自动回落到数据目录——所以升级不需要手动改设置，把整个目录（含 `data` 存档）搬到 `modules-data/cabinworld` 即可。
- 数据放在 `modules-data/cabinworld/` 而不是模块目录里，是为了让发布包只有代码和文档（约 260 KB，未压缩）：模块目录一变，插件就会重新拍一份快照再加载，把 360 MB 的游戏放进去等于每次写存档都复制一遍。
- 补丁只写副本（`--no-backup`，不落 `.bak`），官方 `bridge/` 一个字节都不动；重建时只复制官方的代码，`docs/` 和 `data/` 不碰。
- 副本桥的日志在 `modules-data/cabinworld/bridge-host/host.log`，pid 记在同目录 `host.pid`，重建失败的原因写进 `sync.log`。
- 停桥只按命令行确认身份（含 `bridge-host` 的 node 进程，或 `bridge/bridge.mjs`），不会误杀别的进程；重启桥也不会把插件宿主一起关掉。
- 补丁锚点对不上（比如上游 1.1 改了 `bridge.mjs`）时不会卡死：副本自动回落到**未打补丁的官方桥**照常运行，原因写进 `sync.log`，`.patched` 记成 0。

## 常见问题

- **桥没在运行 / 连不上**：面板点「启动小屋世界」（会同步副本并拉起副本桥）；也可以手动跑 `node "<模块数据目录>\bridge-host\bridge.mjs" --config "<模块数据目录>\bridge\bridge.config.json"`（<模块数据目录> 默认是 `~/.dsh/plugins-data/aurabot/modules-data/cabinworld`）。游戏窗口关了桥还在，重开游戏会自动连回。
- **重启 DSH / aurabot 之后小屋世界没在跑**：桥和游戏是插件拉起来的子进程，会跟着一起退出（`host.pid`、`bridge.json` 里留着旧 pid，模块不会照着旧 pid 乱杀）。点一次「启动小屋世界」或 `/小屋 启动` 就好，副本桥会重建并自己把游戏打开。
- **游戏没打开（503）**：桥在，但游戏没连上；打开 `CabinWorld.exe` 即可。
- **401 token 不对**：桥重启过。模块会自动重读 `bridge.json`；还不行就面板点「启动小屋世界」重启副本桥。
- **端口被占（启动报错）**：改 `<游戏目录>\bridge\bridge.config.json` 的 `http.port`（或 `0` 自动选），重启桥。
- **一键安装下载很慢/失败**：手动从 Release 下载 zip 解压到游戏目录；或等一会儿再试（匿名配额每小时 60 次）。
- **想卸载**：删掉本模块文件夹（`modules/cabinworld/`）就不加载模块了；游戏本体和 `data\` 存档在 `modules-data/cabinworld/`，插件卸载时默认保留，想一起清就删掉这个目录（想留存档先把 `modules-data\cabinworld\data` 拷出来）。

## 权限与数据来源（给审核看）

| 能力 | 用在哪 | 数据从哪来 |
|---|---|---|
| `network` | 一键安装查 GitHub Release、下载游戏包 | 只有 `api.github.com` 和 GitHub 的 Release 下载地址；没有别的联网目标 |
| `filesystem` | 读写游戏目录、桥配置、存档 | 模块数据目录 `modules-data/cabinworld`（设置里那条旧游戏目录只有确实装着 `CabinWorld.exe` 时才用） |
| `process` | 启动桥（node 子进程）和游戏本体 | 只启动模块自己准备的那两个程序，按 pid 或命令行确认身份，不做别的进程操作 |
| `plugin-internals` | `api.core.http`（面板接口复用插件的 HTTP 服务）、`api.core.hub.runSystemTurn`（自动生活让她在后台自己活动一轮） | 自动生活默认关，只有主人在面板里打开才会跑；用的是已存在的小屋世界会话，不新建会话 |
| `plugin-config` | 只读 `api.config()` 拿 `ownerQQ`、`ownerName`，判断谁是主人、她该怎么称呼 | 不写插件配置、不碰 Cookie；读不到就退回默认称呼 |

自动生活是唯一会主动触发模型回合的功能（`hub.runSystemTurn`），所以它默认关闭，面板里写明「打开后她会在你不说话时自己活动」。

### 按审核的最高一档，需要单独说明的三处

| 调用 | 为什么需要 | 数据从哪来 | 怎么验证来源与边界 |
|---|---|---|---|
| `api.core.hub.runSystemTurn('cabin-life', …)` | 让「自动生活」在后台自己活动一轮 | 提示词是模块里写死的固定文本 + `cabin_status` 的真实返回；不读 QQ 消息、不带任何用户输入 | 默认关，只在面板里打开才跑；只作用于 `system:cabin-life` 这一个会话（`api.on('model')` 也只对它会话生效），不新建会话、不影响 QQ 会话；规则是**一次只调用一个工具、做完一件可以接着做下一件**（没有「最多两件」的上限，靠每日次数上限和最小间隔兜底） |
| `memory.addEvent({ tags: ['小屋世界'] })` | 把游戏判定过的事写进她的记忆 | 只有桥返回 `status:"done"` 的 `result.happened`（或 `/小屋` 命令里同样 done 的动作） | 只写 `happened`/label 文本（截断 300 字），不写 token、路径、原始 JSON；面板「把经历记进记忆」可关，默认开 |
| `api.sendText('private:' + ownerQQ, …)` | 自动生活跑完给主人一句汇报 | 桥的事件流（最近 20 分钟 done 的那件事）+ 当前位置；**只发给主人本人** | 收件人取自 `api.config().ownerQQ`，不来自消息内容；`autoLifeNotify` 可关；发之前先去掉文本里的尖括号标签 |

不调用 `hub.receiveOwnerMessage`、不调 `api.lib()`，也不往群里发消息。
## 许可

- 本模块：MIT。
- Cabin World：代码 MIT，美术/数据/文档 CC BY 4.0，署名「Cabin World by VADS」；Naiwa 店员像素图属于同人，不在许可范围内（详见游戏目录 `LICENSE` / `LICENSE-NOTES.md`）。

## 能设置的参数

| 层 | 在哪改 | 参数 | 生效方式 |
|---|---|---|---|
| 模块面板 | 小屋世界页 → 她记住了什么 | 最近写进记忆的 30 条（时间 + 内容） | 打开页时自动读，也能点「刷新」 |
| 模块面板 | 小屋世界页 → 自动生活 | 开关、多久一次、每天最多几次、允许花钱、自动生活后发 QQ 告诉我、模型、思考强度 | 点「保存设置」，几秒生效 |
| 模块面板 | 小屋世界页 → 小屋世界里的名字 | 小屋世界里的名字 | 点「保存名字」，不用重启 |
| 模块面板 | 小屋世界页 → 1.1 可选内容 | 桥的 `cabin_update_plan` 列出来的那些开关（关着就是 1.0 的样子） | 点「保存可选内容」，重启游戏后生效 |
| 模块面板 | 小屋世界页 → 桥设置 | 端口、启动时自动开游戏、天气模式 | 点「保存桥设置」，再点「重启小屋世界」生效 |
| 模块面板 | 小屋世界页 → 模块设置 | 写记忆、群聊只读、状态注入（私聊 + **群聊里也塞一点状态**：位置、正在做什么、天气） | 点「保存设置」，几秒生效 |
| 桥文件 | `bridge/bridge.config.json`（副本桥也读这份） | `displayName`、`hostName`、`http.port`、`launchGame`、`weather.mode`、`waitMs`、`dataDir`、`gameExe`、`resident` | 改完重启桥 |
| 游戏 | `cabinworld.ini` | `data=`、`save=` | 重启游戏 |
| 游戏资源 | `CabinWorld.exe` 内嵌 + 包里的 `game/` | 角色美术、资源里的名字 | 1.1 的 zip 里带了 `game/`（脚本与部分资源），但美术和住户资料仍打在 exe 里；要改得拿上游源码 + Godot 4.7.2 重导出 |

### 启动按钮认得三种状态

| 现场 | 行为 |
|---|---|
| 桥不在（18790 没人听） | 同步 `bridge-host` 副本并启动它，游戏由副本桥自己拉起 |
| 桥在、游戏不在 | **只启动游戏 exe**（带 `-- --data <dataDir>`），不碰桥 |
| 桥在、游戏也在 | 直接提示「已经在运行」，不会多开 |

点完最多等 20~25 秒，按钮旁边会写实际结果（连上了 / 窗口起来了但没连上 / 没起来）。如果游戏进程卡住，去任务管理器结束 `CabinWorld.exe` 再点一次。

## 名字与 aurabot 同步

**能同步的**

| 小屋世界 | 来源 | 现在 |
|---|---|---|
| 桥侧显示的名字（`displayName`） | 手填 / 当前人格名 / 机器人 QQ 昵称 | 已同步成 **漪漪凛**（= 机器人 QQ 昵称）；游戏画面里的名字是另一套，见下 |
| 机器人软件名（`hostName`） | 跟着名字自动变，不用手填 | 和 `displayName` 一样 |
| 她对主人的称呼（规则里） | `config.ownerName` | 叫「爸」 |
| 做完的事进记忆 | `memory.addEvent`，标签「小屋世界」 | 已接 |
| 谁能用小屋工具 | aurabot 的 `level`（主人私聊才 full） | 自动一致 |

**操作方式**

- 面板「小屋世界里的名字」：点「用当前人格名」或「用 QQ 昵称」→「保存名字」。游戏连着就立刻改，没连着就等它连回来再点一次。
- QQ 命令：`/小屋 名字` 看两边各叫什么；`/小屋 改名 漪漪凛` 写配置并改游戏里的名字。
- 写之前自动备份 `bridge.config.json.bak-<时间>`；只改 `displayName`/`hostName`/`http.port`/`launchGame`/`weather.mode`，`resident`、`dataDir`、`gameExe` 不动。
- 升级小屋世界会覆盖 `bridge.config.json`，名字需要在面板里再点一次。整个面板只有「重启小屋世界」这一个按钮会重启桥。

**两个名字是分开的**

| | 存在哪 | 怎么改 | 要不要重启桥 |
|---|---|---|---|
| 桥配置里的名字 `displayName` | `bridge/bridge.config.json` | 面板「保存名字」或 `/小屋 改名` | 不要（改游戏里的名字靠 `cabin_rename`） |
| 游戏画面里的住户名 | 存档 `data/saves/residents.json` 的 `name` | 官方 1.1 的 `cabin_rename`（发 `personal.do {action:"rename"}`），背包/日记/编号都不变 | **不要**，改完立刻生效 |

上游包里的 `game/assets/residents.json` 只是**初始默认值**，只在还没有存档时生效；改过名之后以存档为准，不需要重新导出游戏。

**仍然改不了的**：住户 key（公开版只有 `xiaojingyu`，改名不改 key）；真实天气（aurabot 没有天气设置，要用得自己 `POST /v1/weather`）；模型/语音/表情（小屋世界用不到）。

## 自动生活（可选，默认关）

打开后，她会在一个**独立的后台会话**里自己决定做点什么——不是 QQ 私聊，也不发消息：

| | |
|---|---|
| 会话 | `system:cabin-life`（DSH 里能看到这条会话，和 QQ 会话完全分开） |
| 触发 | 每 N 分钟检查一次：游戏在线、她没在做事、今天没超次数，才会跑一轮 |
| 一轮里做什么 | 状态直接写在提示词里（不用先调一次），她再自己决定：去公园/汤屋/电玩城、荡秋千/钓鱼/泡汤/看鱼、饿了买吃的、困了睡觉；规则是**一次只调用一个工具，做完一件可以接着做下一件**，觉得够了就停 |
| 模型 | 可在面板单独指定 provider/model，以及思考强度 `low` / `high` / `max`（留空=模型默认；不支持推理的模型会自动忽略） |
| 只影响谁 | `api.on('model')` 只对 `system:cabin-life` 生效，不动 QQ 聊天用的模型 |
| 花钱 | 「允许她自己花钱」关掉后只吃背包里的东西，不去小卖部 |
| 记忆 | 动作 `done` 时照常写进记忆（标签「小屋世界」） |

设置项：`autoLife`、`autoLifeMinutes`（默认 45，最小 10）、`autoLifeMaxPerDay`（默认 8）、`autoLifeAllowBuy`（默认开）、`autoLifeNotify`（默认开，跑完私聊告诉主人）、`autoLifeProvider`、`autoLifeModel`、`autoLifeEffort`。

调试：`GET /aurabot/api/ext/cabinworld/auto-life/state` 看状态；`POST .../auto-life/now` 立刻跑一轮（不管间隔；只收 POST，且受本机鉴权）。

注意：每轮都是一次模型调用（花 token）；她会真的在游戏里走动、买东西，存档会变。

## 省 token：提示词与返回值做过哪些精简

| 位置 | 之前 | 现在 |
|---|---|---|
| 工具定义（每轮都发） | 2027 字符 | **1673 字符**（13 个工具的 name+description+parameters 序列化长度） |
| 规则 `RULE`（主人私聊每轮） | 约 450 字符 | **541 字符**（8 条；比早期多了「高级」「地方」两行，为了提四类新工具和常用地点） |
| `cabin_status` 返回 | 约 2800 字符（摘要 + 原始 JSON） | **约 600 字符**（摘要 + 关键字段；随背包和队列长度浮动） |
| `cabin_look` 返回 | 约 2500 字符 | **约 600 字符**（只给家具清单；随屋里东西多少浮动） |
| 动作（go/use/buy/eat）返回 | 摘要 + 2500 字符原始 JSON | **只有摘要**（happened / 钱 / 背包） |

原则：模型要判断的东西（位置、钱、饱腹、happened、失败原因）都在摘要里；原始 JSON 只在失败时由错误信息体现，不再整段回灌。

注意：工具描述改一次，DeepSeek 的提示缓存会失效一次，之后重新稳定。

## 面板：为什么只有一栏

模块原来同时声明了 `settings`（框架自动表单）和 `panel: 'panel.js'`，Aurabot 的 `ExtPage` 会把它们渲染成两块卡（`.../dsh-aurabot-qq/client/client.js:3781`），所以面板上「设置」和「小屋世界」各占一块，看着是两栏。

现在改成：`index.mjs` 只留 `defaults`（不再声明 `settings`），所有设置搬进 `panel.js`，一页只有一张卡，从上到下是「状态四行（桥 / 游戏 / 文件 / 高级）→ 一键安装 / 启动 / 重启 / 取一次状态 / 刷新 → 六个折叠段」，折叠段依次是**她记住了什么 → 自动生活 → 小屋世界里的名字 → 1.1 可选内容 → 桥设置 → 模块设置**（默认都收起，标题右边带一句概况）。`api.settings()` 仍然返回 defaults + 已保存值，工具、命令、`/health` 完全不受影响。

- 设置项改成纵向排列（标题 / 说明 / 控件），不再用 `ui.Row` 的左右两列。
- 保存走 `save({...全量})`，保存后几秒内生效，不用重载模块。
- 旧版（两块布局）要回退，请用 git 或备份恢复。

## 本次安装与验证记录（游戏 1.1，这台机器）

- 游戏：`modules-data/cabinworld`（上游 `V1.1`，`CabinWorld-win64.zip` 约 287 MB，解压后约 362 MB；装的时候会把内层 `CabinWorld\` 的内容上移到根目录）。
- 桥：`http://127.0.0.1:18790`，`data\bridge.json` 每次启动换 token；`data\saves\` 是正式存档（不要外传）。实际跑的是 `bridge-host/` 副本（`.patched` = 1）。
- 模块：`~/.dsh/plugins-data/aurabot/modules/cabinworld`，在 Aurabot 1.2.1 里 `running: user`、无报错，注册了 13 个工具、`/小屋` 命令、18 个面板路由（`grep -c "api.route(" index.mjs` = 18）。睡觉与工具姿势两类由 `lib/patches/` 打到副本桥上；餐厅、电玩城/棋盘由上游 1.1 官方桥自带。

已验证（都可以重跑）：

| 检查 | 命令 | 结果 |
|---|---|---|
| 安装自检（含实机走公园/荡秋千/买水/喝水/喂鱼/叫停） | `<模块数据目录>\selfcheck.cmd`（上游自带） | 全部 ✔ |
| 工具/命令/规则 + 真实调用 | `node test/smoke.mjs` | 挂上的 = `CORE`∩桥清单（这台机器 13 个）、`cabin_status` 返回真实位置、`cabin_go park` 完成（游戏没开时会如实报「还没连上」） |
| 权限边界 | `node test/scopes.mjs` | 主人私聊 = `CORE`∩桥清单 / 群聊 0 个；开 allowSocial 只 2 个只读（看状态、看身边）且要求全主人；system 0 个 |
| 高级协议（餐厅/睡觉/工具姿势） | `node test/advanced.mjs` | `CORE`∩桥清单、描述各一行、菜单、作息决策、床上快照、姿势 |
| 桥补丁可重放 | `node lib/patches/apply.mjs --game <游戏目录> --dry` | 幂等；锚点缺失会停下并以退出码 2 结束 |
| 一键安装三环节 | `node test/install-check.mjs [已下载的zip]` | 查到最新 tag、流式下载写盘、解压 + 定位 start.cmd |
| 一键安装端到端 | 面板「一键安装」或 `POST /aurabot/api/ext/cabinworld/install` | 下载 287 MB → tar 解压 → 复制，保留 `data\saves`，临时目录自动清理 |
| 失败提示 | `node test/failures.mjs`（`CABIN_OFFLINE=1` 再测游戏没开） | 文件缺失 / token 不对 / 503 三种都是中文提示，不抛栈 |
| 桥重启后 token 变化 | 重启 `start.cmd` | token 变了，模块自动重读并恢复，游戏自动连回 |
| 记忆写入 + 状态注入 | `node test/integration.mjs` | `happened` 写进记忆（标签 `小屋世界`）；群聊不注入状态；定时器 2 个、上下文本体 1 个 |
| 面板脚本 | `node test/panel.mjs` | 语法、组件、挂载后的渲染树；面板请求过的每个路径都在 `index.mjs` 注册的路由里；`call` 抛错时顶部有「取状态失败」文案 |

还没做的：在 QQ 私聊里让她真的用一次（验收标准第 4、5 条）。建议这样说：
「去公园荡秋千」→ 游戏里应该真的走过去荡起来；再说「说说你刚做了什么」→ 她按 `happened` 说，面板「心情与记忆」里能搜到。
