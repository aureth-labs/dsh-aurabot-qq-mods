# 小游戏脚本工坊（game-scripts）

让她自己写小游戏脚本，在本机跑起来，再把结果带回聊天。

默认用 Aurabot 自己的 Node，不需要 PowerShell 7；PowerShell 只是可选运行时。脚本目录、运行时、超时和权限上限都由主人在面板里指定。

## 做什么

- 主人说「写个猜数字 / 骰子 / 贪吃蛇小游戏」，她用 game_script_save 把脚本写进脚本目录，再用 game_script_run 跑，把 stdout 和退出码带回来。
- 脚本是自包含的一次性小游戏：打印文字结果，或者从 stdin 读一行 input；需要跨轮状态时，可以自己在脚本目录里存 JSON。
- 默认 Node 脚本跑在 Node 权限模型里：只能读写脚本目录，不能启动子进程。PowerShell 模式没有这个沙箱，见下面的限制。
- 找不到 PowerShell 时会直接说清楚路径怎么填，不会只回一句「再试试」。

## 怎么用

### 面板设置

| 设置项 | 默认值 | 说明 |
|---|---|---|
| 脚本目录 | 空 | 留空用模块数据目录下的 scripts/；相对路径也相对模块数据目录；绝对路径直接用 |
| 运行时 | Node | Node 或 PowerShell。Node 不需要 PowerShell 7 |
| PowerShell 路径 | pwsh | 只在运行时是 PowerShell 时用；找不到就填完整路径，例如 C:\Program Files\PowerShell\7\pwsh.exe |
| 单次超时（秒） | 20 | 1~300 秒；到点杀掉脚本进程树 |
| 输出上限（KB） | 16 | 1~64 KB；stdout 和 stderr 合计超过就停掉 |
| 脚本大小上限（KB） | 64 | 1~512 KB；保存和读取都会检查 |
| 每小时最多运行次数 | 30 | 1~200 次；重载模块后计数清零 |
| Node 权限模型 | 开 | 开：只能读写脚本目录，不能起子进程；关：脚本拥有和 Aurabot 一样的权限 |

改完设置不用重载模块，下一次命令或工具调用就会用新值。

### 命令

命令只给主人用，私聊和白名单群都能发。查看代码和查看路径只在主人私聊里返回。

    /脚本 列表
    /脚本 查看 <名字>
    /脚本 运行 <名字> [参数...]
    /脚本 删除 <名字> 确认
    /脚本 路径
    /脚本 帮助

也可以直接发：

    /脚本 <名字> [参数...]

例如 /脚本 snake 10，等于运行 snake 并把 10 作为第一个参数。

命令带了确认（删除必须加「确认」），避免手滑删脚本；命令日志只记录 /脚本，不记录后面的参数。

### 工具

工具只在主人私聊（level 为 full）里出现，群里不会给她这些工具：

| 工具 | 作用 |
|---|---|
| game_script_save | 写脚本：name、code、overwrite；同名已存在时必须 overwrite=true |
| game_script_run | 跑脚本：name、args 数组、可选 input；返回退出码、stdout、stderr |
| game_script_list | 列出脚本，按修改时间倒序 |
| game_script_read | 读脚本源码，改之前先看 |

脚本名只能用小写字母、数字、下划线、短横线，1~40 个字，并且要以字母或数字开头；大小写会统一成小写。路径、点开头的名字、Windows 保留名（con、nul、com1 之类）都不接受，符号链接不碰。

### 写脚本

Node 模式写 ESM（.mjs）。脚本的工作目录就是脚本目录，参数从 process.argv 取，stdin 里是工具传的 input（没有就立即 EOF）。

    // dice.mjs
    const sides = Number(process.argv[2] || 6)
    const n = 1 + Math.floor(Math.random() * sides)
    console.log('掷出了 ' + n + ' 点')

    // guess.mjs：从 stdin 读一次
    import { createInterface } from 'node:readline/promises'
    const rl = createInterface({ input: process.stdin, output: process.stdout })
    const line = await rl.question('猜一个数：')
    console.log('你猜了 ' + line)
    rl.close()

PowerShell 模式写 .ps1，参数用 param 接：

    param([string]$Name = '小鲸鱼')
    Write-Output "你好，$Name"

Node 脚本默认只能用 node:fs 读写脚本目录；读脚本目录外的文件、起子进程都会报 ERR_ACCESS_DENIED。需要这些能力时，主人在面板里关掉 Node 权限模型，风险由主人承担。

脚本里不要写死等待多轮输入：每次运行都是新进程，stdin 只给一次 input。要做多轮，就在脚本目录里存状态文件，每次运行读出来、改完写回去。

## 会访问的网址

不访问任何网址。

模块自己不发 HTTP/WebSocket 请求，也没有声明 network 能力。脚本子进程理论上可以联网（Node 权限模型只限制文件和子进程，不拦网络），所以不要跑来路不明的脚本；这个模块不会把 QQ 消息、Cookie 或账号配置发给任何地址。

## 限制与安全

- 只给主人用；工具只在主人私聊出现，命令默认仅主人可用。
- 同一时间只跑一个脚本；一小时内最多跑 maxRunsPerHour 次。
- 超时和输出上限到了就用 SIGKILL 杀进程，Windows 上再用 taskkill /T /F 杀整棵进程树。
- 不用 shell，参数逐项传给子进程；名字和路径都会校验，拒绝符号链接。
- 子进程只拿到最小环境变量（PATH、SystemRoot、TEMP、HOME、LANG 等），不会继承 NODE_OPTIONS、API key 或其他密钥。
- Node 权限模型按版本选参数：Node 22.13 / 23.5 及以上用 --permission，更早的 22.x 用 --experimental-permission。开启时只给脚本目录读写权限，并禁止子进程。
- PowerShell 模式用 -NoProfile -NonInteractive -ExecutionPolicy Bypass -File 启动，没有沙箱；PowerShell 脚本拥有和 Aurabot 进程一样的文件和进程权限。只有信任脚本时才用这个模式。
- 两种模式都不限制 CPU 和内存，只靠超时和输出上限兜底。
- 脚本以运行 Aurabot 的系统用户身份执行；不要把脚本目录设成包含敏感文件的目录。
- 运行计数在内存里，重载模块或重启 Aurabot 后清零。

## 目录与文件

    modules/game-scripts/
      module.json
      index.mjs          入口：设置、命令、工具、规则
      lib/policy.mjs     设置校验、名字/路径、环境变量、权限参数
      lib/store.mjs      脚本目录的增删读写
      lib/runner.mjs     子进程启动、超时、输出上限、进程树清理
      test/              node:test 测试
      README.md
      LICENSE

脚本目录在第一次保存或列出时自动创建。默认是模块数据目录下的 scripts/，不是模块自己的安装目录。

## 测试

在仓库根目录运行：

    node --test modules/game-scripts/test/*.test.mjs

测试只用 Node 内置模块，不需要安装依赖。

## 许可

MIT。
