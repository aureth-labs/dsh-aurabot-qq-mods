# 台球

桌宠（`pet`）里那台台球桌搬出来单独成了一个模块：拖白球出杆打八球，规则、物理、画面全在你这台机器上算。

- **桌面球桌**：整个工作区当球桌，透明置顶，球桌以外照常点东西。这窗口不吃键盘（`focusable: false`），收工点 HUD 上的「退出台球」
- **规则**：WPA 八球的一个子集 —— 开球 → 开放台面 → 打进定组 → 犯规（先碰错组 / 空杆 / 白球落袋）→ 自由球摆球 → 8 号定胜负。故意没做：指定袋、飞出台面、开球四颗碰库的严格线、故意犯规判负
- **两个座位**：你 + 第二个玩家轮流拖，也可以让电脑接管第二个座位（新手/普通/高手三档出杆误差）
- **球面**：装了桌宠就借它素材包的 idle 动画，每颗球都是一只游的小鲸鱼；没装就是普通色球，不影响打球

## 安装

Aurabot 插件 **1.2.0 及以上**，在面板「模块市场」安装后启用。

画面是 Electron 窗口，所以**要有 Electron 运行时**。装好之后第一次点「桌面球桌」，状态卡会告诉你缺不缺：

1. 电脑上装过桌宠 → 直接借它那份 `electron.exe`，什么都不用下载；
2. 没有 → 面板点一次「安装 Electron」（用本机 npm 装钉死的 45.1.0，走 npmmirror，只装一次）；
3. 连 npm 都没有 → 在 `modules-data/billiards/app/` 里手动运行 `npm install -D electron@45.1.0`。

本模块**不会自己偷偷下载或启动任何东西**：装运行时、开局面都是面板上按下去才发生的。

关于「模块不要让用户机器跑 `npm install`」那条规范：本模块自身零 npm 依赖（模块代码只用 `node:*`，所以不需要 `build`）；上面那次 `npm install` 装的是给 `app/` 里那个独立 Electron 客户端用的**运行时**，不是模块的依赖，装完也不再需要——和 `pet` 模块装桌宠运行时是同一个做法。

## 怎么玩

按住白球往后拖 → 拖得越远力度越大 → 松手出杆。拖的时候屏幕上画出瞄准线、ghost 球和目标球出射方向；线变红说明这条线先碰到不该碰的球（会判犯规）。
犯规之后是自由球：拖白球到想放的位置松手，红线 = 压球 / 出界 / 堵洞口，放不下会自动吸附到最近的合法位置。

## 配置

| 设置 | 默认 | 说明 |
|---|---|---|
| 球面 `ballSkin` | `pack` | `pack` = 借桌宠素材包的 idle 动画；`plain` = 普通球面。找不到素材自动回落普通球面 |
| Electron 安装镜像 `electronMirror` | 空（npmmirror） | 只有点「安装 Electron」时用到 |

## 权限

- `filesystem`：读写自己的数据目录 `modules-data/billiards/`（把 `lib/client/` 模板铺成 `app/`、写 `anims.json` 和进程记录 `process.json`），以及只读地扫一眼桌宠的 `modules-data/pet/packs/*-animation/` 拿动画文件名
- `process`：启动两个本机程序 —— `electron.exe main.js`（球桌窗口）和 `npm install -D electron`（只在你点「安装 Electron」时）

**没有** `network`：模块自己的代码一条网络请求都不发，页面里的 `<video>` 用 `file:///` 本地地址播素材，规则与物理都在页面里。唯一可能出网的是 npm 子进程去镜像下运行时，那是你按下去、并且只有第一次。也不读插件配置、不碰 `api.core`。

## 文件

```
index.mjs                  模块定义：状态 / 桌面球桌 / 关掉 / 安装 Electron
panel.js                   面板上的按钮和状态卡
lib/anims.mjs              素材包 → 球面地址表（纯函数）
lib/electron.mjs           运行时定位、镜像、环境变量（纯函数）
lib/client/main.js         Electron 主进程：只管开窗
lib/client/arena.html      桌面球桌（物理 + HUD + 交互）
lib/client/billiards-rules.js  八球规则引擎（UMD，零依赖，浏览器和 node 都能跑）
lib/client/arena-preload.js 渲染页 ↔ 主进程的最小桥
```

## 排查

- **面板说「已打开」但屏幕上什么都没有**：客户端起来就自杀了。看 `modules-data/billiards/process.json` 里那个 pid 还在不在进程表里；不在就是主进程没抢到单实例锁——主进程把 app name 和 userData 都钉成 `aurabot-billiards`，专门避开桌宠（那份 `app/` 没有 `package.json`，默认名是 `Electron`，不钉死就抢同一把锁、共用同一份缓存）。手改过 `app/main.js` 里那两行的话改回来即可。
- **状态卡说「客户端文件不全」**：`modules/pet` 那种手改坏不了这里 —— 模板在模块文件夹里，每次开台会按 sha1 补齐到 `app/`；还缺就是模块文件夹本身被删过，重装模块。
- **球不滚动 / 慢动作**：`setBackgroundThrottling(false)` 没生效，多半是 `modules-data/billiards/app/main.js` 被手改过；重装模块就补回来了。
- **球没有动画**：桌宠素材包不在 `modules-data/pet/packs/default-animation/`（或你把 `ballSkin` 设成了 `plain`）。状态卡「球面」那行写的是实际读到的段数。
- **想自己验一局**：规则引擎有 30 条 node 单测（`test/billiards-rules.test.mjs`），`npm test` 一次跑完，不用开窗口。页面上还留着 `__autoGame()`（两个电脑玩家不打指针跑完整局）和 `__dump()`（当前规则与球位）两个 devtools 钩子，但这扇窗是 `focusable: false`，键盘事件进不去、也没有右键菜单，要用就得临时在 `app/main.js` 里加一句 `arenaWin.webContents.openDevTools()`。

## 来源与许可

本模块代码 **MIT**，© 2026 asyncxt，见 `LICENSE`。

台球模式原生长在大肥鱼桌宠的 Electron 客户端里（`pet` 模块的 `pet-client/`），这次是把它整段拆出来：拆掉了「白球 = 宠物窗口」那条联动（球钉模式），素材交付从「插件 HTTP 接口 + 令牌」改成「本地 `anims.json` + `file:///`」，其余规则、物理、交互与原作一致。
桌宠客户端本身移植自开源项目 [dsh-pet](https://github.com/PC2005-cloud/dsh-pet)（作者 PC2005-cloud，代码 MIT）；形象素材「大肥鱼」是 CC BY-NC-SA 4.0，**不在本模块包里**（由桌宠下载到自己的数据目录）。细节见 `THIRD-PARTY-NOTICES.md`。
