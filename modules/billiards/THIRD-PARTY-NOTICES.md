# 第三方声明

本模块自研代码为 MIT（见 `LICENSE`）。台球模式不是从零写的，它是桌宠模块里那套客户端的拆分；
桌宠客户端又移植自开源项目 dsh-pet。下面按「随本模块分发的东西」逐项说明。

## dsh-pet —— 桌宠客户端形态的上游（代码，MIT）

- 仓库：<https://github.com/PC2005-cloud/dsh-pet>
- 作者：PC2005-cloud
- 许可：MIT（Copyright (c) 2026 PC2005-cloud）

本模块**没有**直接复制 dsh-pet 的文件：台球是 Aurabot 侧写的（Electron 透明置顶窗 + DOM 球 +
本地规则引擎）。沾到上游的是「客户端形态」这一层，经由 `pet` 模块间接传承：

| 本模块位置 | 形态来源 | 说明 |
|---|---|---|
| `lib/client/main.js` | `pet` 模块 `pet-client/main.js` 的 `openArena()` | 窗口参数（全屏透明 + 点击穿透 + `focusable: false`）、`setBackgroundThrottling(false)`、分离进程启动方式 |
| `lib/electron.mjs` | `pet/index.mjs` 的 Electron 安装与启动段 | `ELECTRON_RUN_AS_NODE` 必须删、npm-cli.js 的候选位置、`ELECTRON_MIRROR` 默认 npmmirror、版本钉 45.1.0 |

## 「大肥鱼」形象素材 —— 不在本模块包里（CC BY-NC-SA 4.0）

- 上游：<https://github.com/PC2005-cloud/dsh-pet>（形象与动画素材）
- 许可：**CC BY-NC-SA 4.0**（署名 - 非商业性使用 - 相同方式共享），署名 **PC2005-cloud**

台球只是**引用**这些素材：运行时读桌宠数据目录 `modules-data/pet/packs/<包名>-animation/*.webm`
的**已有文件**，把它们当 `file:///` 地址交给页面里的 `<video>`。zip 里一个字节素材都没有，
下载与落位由 `pet` 模块负责，授权关系不变 —— 用户装了桌宠才有素材，卸了桌宠就回落普通球面。
商用请避开这批素材（上游许可禁商用）。

## 台球规则与物理

`lib/client/billiards-rules.js`（WPA 八球子集）与页面里的碰撞 / 袋口 / 摩擦都是本模块自研，
没有使用任何第三方台球实现或库；页面里也没有外部脚本、字体、音频和图片请求。

## Electron

运行时**不随模块分发**，也不由本模块下载：优先复用桌面上已经装好的 `electron.exe`，
没有才让你在面板点一次「安装 Electron」（本机 npm 从官方镜像装）。
npm 包 `electron` 自身是 MIT，其二进制内含 Chromium / Node.js 各自的开源许可，由 npm 那次安装落地，
与本模块的包内容无关。
