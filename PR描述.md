# PR 描述（提交时直接复制以下内容）

## 这个模块做什么

**抖音看直播（kanzhibo）0.9.8**：用独立浏览器（Edge/Chrome，独立 profile，不影响日常使用的窗口）经 CDP 挂在抖音直播间，替主人守直播。

- 进房：给直播间地址，或给主播主页自己找「直播中」；下播自动退出，再开播自动回来（可按时段）。
- 进房后发一条主人定制的评论，同一个房间只发一次。
- 续粉丝团灯牌：每天首次进房后自动续灯牌（半自动默认：先发红框截图等主人回「确认」再点；也可全自动）。
- 送礼：只认主人私聊指令，另有一道确认锁。
- 防误点：点之前先验目标面板（选点、唯一性、两帧签名一致才收），点之后按「+100 / 聊天播报 / 任务进度」三级确认结果。
- 崩溃恢复：断电/重启后凭状态文件知道今天做过什么，不会重复送。

自带四层测试：离线自检 208 项（`test/verify.test.mjs`）、执行级点击测试 9 项（`test/click.test.mjs`）、AX 无障碍树通道测试 10 项（`test/ax.test.mjs`）、安装测试 4 项（`test/install.test.mjs`）。

## 自查

- [x] `npm run check` 通过，本地试过这个模块
- [x] `category` 选好了，运行过 `npm run catalog`
- [x] `capabilities` 如实声明，下面说明了为什么需要
- [x] 会访问的域名：`live.douyin.com`、`www.douyin.com`（含页面自身加载的字节 CDN 静态资源）、`127.0.0.1`（本地浏览器 CDP 调试端口）
- [x] 新模块（无旧版本）
- [x] 代码没有混淆，打包产物由源码在 CI 构建
- [x] `LICENSE` 允许本仓库分发（MIT），无第三方代码
- [x] `author` 已按仓库规则改为**首次引入本模块的 PR 作者** `h752603-source`（原 `YG`），`module.json` 与打包产物 `dist/release.json` 一致

### capabilities 说明

| 能力 | 为什么需要 |
|---|---|
| `network` | 访问抖音直播页、本地 CDP HTTP 接口 |
| `filesystem` | 模块数据目录：状态文件、点击前后的证据截图 |
| `process` | 启动 Edge/Chrome 浏览器进程（`--remote-debugging-port`） |
| `plugin-config` | `api.settings()` / `setConfig` 读写模块设置 |
| `plugin-internals` | `api.core.http`（面板路由解析请求参数） |

不采集用户 Cookie/消息，不向无关地址发送数据；不做群发、加好友；不绕过验证码、不刷量。点击页面前有面板校验 + 主人确认（半自动模式默认），且有每日去重，不会重复消费。

## 进程 / 网络 / CDP 的实际启动路径

这块涉及起子进程、开本地端口、连 WebSocket，所以单独列清楚。

### 实际启动路径（一条线，从头到尾）

1. **模块内**：主人说「看直播」→ `api.command('/看直播')` → `tick()` → `ensureInRoom()` 决定进哪个房间。
2. **起浏览器**：`ensureBrowser()` → `launch()`（`index.mjs` 的 `launch()`）
   - 找可执行文件：优先面板里填的 `browserPath`；没填就按 `findBrowser()` 的顺序找
     `msedge.exe` → `chrome.exe` → `LOCALAPPDATA\...\chrome.exe` → `LOCALAPPDATA\...\chromium.exe`。
     一个都找不到 → 抛错：`找不到 Edge / Chrome，先装一个，或在面板里填浏览器路径`（**不静默降级**）。
   - profile 目录：`api.dataDir()` 下 `live-profile/`（独立 profile，不碰主人日常浏览器的登录态和 Cookie）。
     启动前先改 `<profile>/Default/Preferences` 里的 `browser.window_placement`（`maximized=true`），
     否则 Chrome/Edge 会用 profile 里存的旧窗口尺寸覆盖 `--start-maximized`，窗口一出来就是小窗。
   - 端口：**随机取 `9300 + random(0..399)`**，即 `9300~9699`。
     只绑 `127.0.0.1`（`--remote-debugging-address=127.0.0.1`），不对外暴露。
   - 命令行：
     ```
     <browser> --user-data-dir=<profile>/live-profile
               --remote-debugging-port=<9300~9699>
               --remote-debugging-address=127.0.0.1
               --no-first-run --no-default-browser-check
               --autoplay-policy=no-user-gesture-required
               --disable-background-timer-throttling
               --disable-backgrounding-occluded-windows
               --disable-renderer-backgrounding
               --disable-features=Translate,MediaRouter,CalculateNativeWinOcclusion
               --window-position=0,0 --start-maximized
               about:blank
     ```
     `detached: true` + `stdio: 'ignore'` + `unref()` —— 浏览器脱离 Aurabot 进程独立活着，Aurabot 退出不会带走它。
     特意**不给** `--window-size`：Chromium 里 `window-size` 会覆盖 `start-maximized`。
   - 就绪探测：每 250ms 探一次 `http://127.0.0.1:<port>/json/version`（单次超时 900ms），最多探 60 次（约 15 秒）。
     通了就把端口写进 `<profile>/live-profile/DevToolsActivePort` 再连。
     15 秒还没通 → 抛错 `浏览器没起来`。
   - **复用已有窗口**：`launch()` 开头先读 `DevToolsActivePort` 里的旧端口，探一下还活着就 `attach()` 复用，
     不重复起窗口 —— 所以第二次开总开关不会弹新窗口。
3. **连 CDP**：取 `http://127.0.0.1:<port>/json/list` 里的页面 target，`WebSocket` 连 `webSocketDebuggerUrl`，
   走 `Runtime.evaluate` / `Input.dispatchMouseEvent` / `Page.captureScreenshot` / `Accessibility.getFullAXTree`。
4. **进房**：`ensureInRoom()` → `Page.navigate` 到 `https://live.douyin.com/<roomId>`，等页面自己起播。
5. **做动作**：先 `prepareBadge()` 验面板（只读，不点）→ 主人确认（或全自动）→ `commitBadge()` 才真点。

### 端口

| 端口 | 谁在用 | 绑定 |
|---|---|---|
| `9300~9699` 随机 | 模块自己起的 Edge/Chrome 的 CDP | 只绑 `127.0.0.1` |
| `50360` | Aurabot 面板自带（模块的 `/probe` 调试路由挂在这下面） | 本机 |
| `8000+` | 抖音页面自身请求（出站） | 出站 |

端口号写在 `<profile>/live-profile/DevToolsActivePort`，下次复用。占用时随机重取，不会撞固定端口。

### 失败降级（逐级实测过）

| 失败点 | 表现 | 降级行为 |
|---|---|---|
| 找不到浏览器 | `找不到 Edge / Chrome，先装一个，或在面板里填浏览器路径` | 抛错，不静默继续；主人可在面板填 `browserPath` |
| 浏览器 15 秒没起来 | `浏览器没起来` | 抛错，本轮 tick 结束，不重复 spawn |
| CDP 断了 / `Runtime.evaluate` 失败 | `挂直播出错：<原因>` | **掐断 CDP 连接**（`cdp.close()`），下个 tick 重新 `launch()`；已开的待确认闸门不会被这次异常作废 |
| CDP 调不通 | `连不上 CDP` | 立即失败，不等 20 秒超时（0.9.7 修的就是这个：以前断线后每个 `evalJs` 白等 20 秒） |
| 面板不是粉丝团面板 / 没找到按钮 | `面板里没找到可点的「送灯牌 / 点亮」：<原因>` | **不点**，退出并报明确原因 |
| 命中校验不过 | `只有 N/9 点命中，挡在上面的是：<元素>` | **不点**（0.9.8 修：抖音头像徽章被 `pointer-events:none` 包着，原来采样全灭导致粉丝团入口永远点不成） |
| 同名候选不唯一 | `有 N 个都叫「X」的候选` | **不点**，等下一帧 |
| 确认期间目标被换 | `目标变了，不点了`（签名比对） | **不点** |
| 灯牌连挂 3 次 | `灯牌连着 3 次没点上（<原因>）。今天先不自动试了，你顺手点一下？` | 当天降级成「提醒主人自己点」，一天只提一次；成功一轮就把计数归零（只算**连续**失败） |
| 送礼后余额不足 | `送完弹出了余额不足提示，去手机上看一眼，别重复送` | 停下并私聊提醒，不重试 |
| 送完没读到证据 | `按了，但读了 8 秒没找到送出的证据（<方式>），你去直播间看一眼，别重复送` | 停下并私聊提醒 + 发证据截图，**不重试**（宁可不送也不重复消费） |
| 面板上只有「加入粉丝团（1钻）」 | `这个直播间还没加入粉丝团（面板上是「加入粉丝团（1钻石）」），要先加入才能点亮，这次不点` | **不点**（那是开通不是续灯牌，会花 1 钻） |
| 房间已下播 | `直播已结束` | 不做动作，等下次开播自动回来 |

关键原则：**任何一步不确定就不点**。半自动模式下会把红框截图和原因私聊给主人，主人回「确认」才点。

### 降级验证怎么做的

- 上面每条降级都有对应的**离线断言**（`test/verify.test.mjs` 208 项 / `test/click.test.mjs` 9 项），
  用假 CDP 跑真实执行链，验证「不点」和报错文案。
- 真机侧：`/probe` 只读路由可以复现各种状态，不花钱、不点真实按钮；
  已实跑过「面板是 Lynx canvas → 改走 AX 无障碍树读文字」、「面板上只有加入粉丝团 → 拒绝点」、
  「房间已下播 → 正确报不像能送灯牌的直播间」三条真实降级。
- 端口与进程侧：`DevToolsActivePort` 复用、`/json/version` 就绪探测、15 秒起不来就报错，
  都是对着真实 Edge 进程验的。

## 审核重点自查（对着 CONTRIBUTING 的六条逐条核过）

| 审核重点 | 本模块的情况 | 怎么核的 |
|---|---|---|
| 代码能读懂，没有混淆，没有在运行时下载并执行代码 | 源码全是明文 JS，无混淆。**不下载也不执行任何远程代码**：`grep -rnE "\beval\(|new Function\|node:vm\|import\("` 在 `index.mjs` / `lib/*.mjs` / `panel.js` 里 0 命中 | 全量 grep |
| `capabilities` 和实际行为一致 | 声明 `network, filesystem, process, plugin-config, plugin-internals`；用仓库自己的 `scripts/lib.mjs` 的 `scanCapabilities()` 扫源码，结果**逐项相同** | `scripts/check.mjs` 已在校验，本 PR 改动后仍 ✓ |
| 联网目标和 README 说明一致，用户的 Cookie、消息等数据没有被发到无关地址 | 源码里全部外连地址只有三个：`live.douyin.com`、`www.douyin.com`（页面自身资源）、`127.0.0.1`（本地 CDP）。**没有任何 fetch/webhook 把数据发往第三方** —— `fetch` 只用于本地 CDP 和抖音页；所有消息出口都是 `api.sendText` / `api.sendImage`（走 Aurabot 自己的私聊），Cookie 只留在本机独立 profile 里 | 全量 grep 外连地址 + 逐个 fetch 出口核对 |
| 不做未经用户同意的群发、加好友、发帖等自动操作 | 没有群发 / 加好友 / 发帖（grep 0 命中）。发评论、送礼、续灯牌三条都要开关：`总开关 enabled`、`半自动 semiAuto`（默认开：先发红框截图，主人回「确认」才点）、`送礼 giftByDm`（只认主人私聊指令）、`续灯牌 renewBadge`。评论同一房间每天只发一次，有每日去重 | 看 `api.settings()` 的每一处分支 |
| 许可证允许本仓库分发，第三方代码已署名 | MIT。**零第三方依赖** —— `package.json` 无 `dependencies`，`lib/` 下 5 个文件全是本模块自己的代码 | 看 `package.json` 与 `lib/` |
| 代码不混淆，打包产物由源码在 CI 构建 | 同上。CI 的「试打包」步从源码打 zip，仓库里不提交 `dist/`（`.gitignore` 已忽略） | 看 `.gitignore` 与 CI 配置 |

补充：模块**不绕过验证码、不刷量**。遇到验证码会停下并把截图发给主人。

## CI 检查（分支上跑通）

模块自带 `package.json` + `package-lock.json`（零外部依赖），所以 CI 里两道测试门禁都会覆盖到它：

| CI 步骤 | 命令 | 结果 |
|---|---|---|
| 根测试 | `npm test` | 32 通过 / 0 失败 |
| 模块校验 | `node scripts/check.mjs --base FETCH_HEAD` | 23 个模块全 ✓（tieba-reader 有一条**既有** dynamic-code 警告，与本模块无关） |
| 模块自己的测试 | `cd modules/kanzhibo && npm ci --ignore-scripts && npm test` | 23 通过 / 0 失败（含 208 项离线自检作为子测试） |
| 搬来的模块的测试（要插件源码） | `AURABOT_PLUGIN_DIR=… node --import ./scripts/plugin-env.mjs --test "modules/*/test/*.test.mjs"` | 895 通过 / 0 失败 |
| 试打包 | `node scripts/pack.mjs --out dist` | 23 个模块全部打包成功，产出 `kanzhibo-v0.9.8.zip` |

打包产物核对：`dist/release.json` 里 kanzhibo 的 `author` 是 `h752603-source`、`version` 是 `0.9.8`。

### 顺带修了一个 CI 的时区坑（`.github/workflows/ci.yml`）

CI runner 默认是 **UTC**，但模块里的作息 / 曲线是按**东八区**设计的，于是 `feed` 的测试会随机挂：

- `feed` 的 `plan()` 用「当天日期」当随机种子。UTC 和东八区在 **22:00~24:00** 之间会差一天，
  种子一变，`tick()` 把饥饿值从 52 拉到 51，断言 `before === 52` 就挂。
- 实测（**上游干净的 `ab7e1486`，不含本 PR 的任何改动**）：
  `TZ=UTC` → 19 项挂 1 项；`TZ=Asia/Shanghai` → 19 项全过。
- 所以这是 `feed` 的**既有**缺陷，不是本模块引入的（本 PR 的改动清单里没有 `feed/` 的任何文件）。
- 修法：在 CI 里显式 `env: TZ: Asia/Shanghai`，别让结果随 runner 默认时区飘。

没有去改 `feed` 的代码 —— 那是别人的模块，该由它的作者来修（把测试改成不依赖墙上时钟，
或让 `plan()` 的种子与时区无关）。本 PR 只把 CI 的时区定死，这样谁提 PR 都不会被这个坑挡住。
