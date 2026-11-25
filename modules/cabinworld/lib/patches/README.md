# 桥补丁：睡觉、工具姿势

小屋世界的 `bridge/` 属于官方 Release 包，一键安装/更新会整目录覆盖。
**电玩城与棋盘、餐厅从上游 1.1 起由官方桥自带**（`bridge/lib/arcade.mjs`、`cabin_restaurant`），
这里只补上游还没做的两类：**睡觉**（`body.sleep`）和**工具姿势**（`body.tool`）。

> 数据（存档）不受影响：补丁只改代码，`data/` 里的经济、战绩、身体状态都留着。

## 打了什么

| 文件 | 改动 | 为什么 |
|---|---|---|
| `bridge/lib/advanced/index.mjs` | 新增 | 两类的接入口：`body.tool` → `body.toolPose`（按住户资料挑姿势，游戏没配就照实说没有）、`body.sleep` 转发到 sleep.mjs；等一帧的 `awaitFrame` 和挑姿势的 `resolveToolPose` 都内联在这个文件里（原来是 `frames.mjs`/`toolpose.mjs` 两个文件，已合并）；把 `hello` 里的 `sleepProfiles`/`toolPoses` 写进 `data/advanced-caps.json` |
| `bridge/lib/advanced/sleep.mjs` | 新增 | `body.sleep` → `body.sleepPlan` 决策；`body.do` 床上动作；`body.get` → `body.state` 快照 |
| `bridge/bridge.mjs` | 7 处插入 | 引入 `createAdvanced`、创建实例并挂到 resident、连接时 `attach`、断开时 `detach`、`TOOLS` 加 `cabin_sleep`/`cabin_toolpose`、`/v1/health` 暴露 `advanced`、`close()` 收尾 |
| `bridge/lib/resident.mjs` | 2 处插入 | 记住 `asleep`/`pose`；`publish()` 的 `sleeping` 用真实值 |
| `bridge/openai-tools.json` | +2 | 其他宿主（AstrBot、LangChain）也能看到这两个工具 |

**没有改游戏本体**：`game/` 一行没动，全部走协议。

## 现在是什么状态（上游 1.1）

- 锚点已经按 1.1 的代码重写过，现在重建出来的 `bridge-host/` 副本是**打过补丁的**（`.patched` = 1，`/v1/health` 里 `advanced.tools` 的 `sleep`、`toolpose` 为 true）。
- 上游以后再改 `bridge.mjs` / `lib/resident.mjs`，锚点可能又对不上：这时模块**不会半改**——有旧副本就继续用旧副本（`.patched` 记 0，原因写进 `bridge-host/sync.log`），没有旧副本就回落到未打补丁的官方桥副本照常运行，睡觉/工具姿势暂时没有，其余功能不受影响。
- 电玩城、棋盘、餐厅不受影响，1.1 官方自带。

## 怎么用

```powershell
node lib\patches\apply.mjs --game <游戏目录>                # 打到官方 bridge/（会改官方树）
node lib\patches\apply.mjs --game <游戏目录> --dry           # 只看会改什么，不写盘
node lib\patches\apply.mjs --bridge <副本目录> --no-backup   # 打到副本、不留 .bak（模块自己就是这么调的）
```

- **幂等**：已经打过的锚点会跳过（输出里是 `＝`），只有缺的才写（`＋`）。
- **不半改**：锚点找不到时先停下、列出位置并以退出码 2 结束；语法不过退出码 3。
- **自动备份**：真正写盘前把原文件复制成 `<文件>.bak-<时间戳>`（`--no-backup` 关掉）。

## 升级小屋世界之后

不用手动重跑：模块发现官方 `bridge/` 变了（指纹变化）会自动重建 `bridge-host` 并调脚本。
如果 `/v1/health` 里 `advanced` 不见了、`.patched` 是 0，就是补丁没打上，看 `bridge-host/sync.log` 里列出的漂移锚点。

## 回滚

一键安装覆盖 `bridge/` 即可（`data/` 存档不动）；副本在 `bridge-host/`，删掉会被自动重建。
