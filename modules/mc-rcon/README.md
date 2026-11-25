# 我的世界服务器分身（mc-rcon）

让 Aurabot 通过 RCON 住进 Minecraft 服务器，在游戏聊天里像群聊一样参与。

## 功能

- **游戏聊天接话**：默认每条都看，出现唤醒词必回；同一个人连发几条会先合并再处理
- **死亡播报**：识别中英文和常见模组死亡消息，在聊天里主动调侃/关心一句
- **跨维度传送**：识别主世界 / 下界 / 末地 / 暮色森林等模组维度（xaero 路点、`Internal-...-waypoints`、`Internal-dim%命名空间$路径-waypoints`、维度别名、完整 id），跨维度先确认再 `execute in`
- **回家**：交给服务器的 `/home [名字]`（支持多个家、自己管维度），模块用 `execute as` 以玩家身份执行
- **自动检测换端**：扫描服务器根目录，用日志时间和 RCON 试连找出正在跑的服并切换
- **权限分级**：游戏内管理员 / 普通玩家 / Aurabot 管理员，命令由模块校验
- **面板**：RCON/日志状态、在线玩家、游戏内时间、最近聊天、手动执行命令/广播

## 环境要求

- Minecraft 服务器开启 RCON：`server.properties` 里 `enable-rcon=true`、`rcon.port`、`rcon.password`
- 能读到服务器日志 `logs/latest.log`（聊天监听靠它；拿不到可以用「外部转发接口」）
- 服务器有 `/home` 命令（可选，回家功能用；没有就把 `guestCommands` 里的 `home` 删掉）
- Aurabot 插件版本 `>= 1.2.0`

## 安装

1. 把 `mc-rcon/` 目录放到 Aurabot 的 `modules/` 下
2. 打开面板「已安装 → 我的世界服务器分身」
3. 填 RCON 地址 / 端口 / 密码 / 服务器日志路径，保存

## 主要配置

| 项 | 说明 |
|---|---|
| `host` / `port` / `password` | RCON 连接信息（server.properties） |
| `logPath` | `logs/latest.log` 的完整路径，聊天监听用 |
| `serverName` | 服务器名字，只用于提示词 |
| `wakeWords` / `nicknames` | 必回唤醒词、其他称呼（一行一个） |
| `chatMode` | `all` 每条都看 / `smart` 智能接话 / `wake` 只回应召唤 |
| `eventsEnabled` | 死亡时主动说话 |
| `admins` | 游戏内管理员名单（一行一个） |
| `guestCommands` | 普通玩家可用操作：`gamemode`、`tp`、`back`、`spawn`、`list`、`time query`、`home` |
| `blockedCommands` | 禁止执行的命令前缀（管理员也拦） |
| `autoDetect` / `serverRoot` | 自动检测正在运行的服务器 |
| `dimensionAliases` | 维度别名（一行一个「别名=维度id」） |
| `personaId` | 用哪张人格卡，空 = 当前人格 |

## 权限

| 身份 | 能做什么 |
|---|---|
| Aurabot 主人 | QQ 里 `/mc` 全部子命令，包括任意 RCON 命令 |
| Aurabot 管理员 | 面板 `qqAdmins` 里的 QQ，同上 |
| 游戏内管理员 | 较广的服务器命令（受禁止名单限制） |
| 普通玩家 | 只能申请安全操作：切旁观/生存、`tp` 坐标、`back`、`spawn`、`list`、`time query`、`home` |

## 回家

- 玩家说「回家」→ 模型写 `<mc>home</mc>`，模块改写为 `execute as <玩家> run home`，由服务器的 home 插件处理家、维度、多个家
- 回某个家：`<mc>home 名字</mc>`
- 服务器没有 `/home` 时，把 `guestCommands` 里的 `home` 删掉即可

## 跨维度与坐标

- 说「去下界 / 末地 / 暮色森林 x y z」或分享 xaero 路点，模块会识别目标维度
- 跨维度时先问确认，确认后执行 `execute in <维度> run tp ...`
- 普通 `tp x y z` 按当前维度；只有「刚才那个点 / 也带我过去」这类指代才沿用坐标记忆

## 游戏内时间

聊天和死亡播报会分别告诉模型「现实时间」和「游戏内时间」（`time query daytime` 换算成清晨/白天/黄昏/夜晚/深夜），不会拿凌晨的现实时间猜游戏里的天。

## QQ 命令

主人 / 管理员在 QQ 里：

```
/mc status
/mc list
/mc say 测试一下
/mc cmd list
```

## 外部转发（可选）

服务器不在本机、拿不到日志时，可以在面板填一个 token，让服务器端把聊天 POST 过来：

```bash
curl -X POST http://<这台电脑>:<端口>/aurabot/api/ext/mc-rcon/ingame \
  -H "content-type: application/json" \
  -H "x-mc-token: <token>" \
  -d '{"player":"Steve","text":"大肥鱼 在吗"}'
```

## 测试

`test/commands.test.mjs` 覆盖命令校验、home 改写和维度识别；需要 Aurabot 插件源码环境（CI 里会跑）。

## 许可

MIT，见 `LICENSE`。
