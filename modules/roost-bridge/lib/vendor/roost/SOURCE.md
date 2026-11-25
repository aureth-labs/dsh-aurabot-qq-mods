# 内置 roost 来源锁定

> 本文件由 `roost-bridge` 模块维护，随包副本与上游 commit 的对应关系以这里为准。
> 本模块整体按 **AGPL-3.0-only** 授权，不依赖任何分发例外。

## 来源

| 项 | 值 |
|---|---|
| 上游仓库 | `https://github.com/tdcq9594/qq-bot-roost` |
| 版本 | `1.1.7` |
| commit | `69320e90eb1778c1ae3b65cc1657376419a9e6fa` |
| 提交信息 | `v1.1.7 — 长期运行更省内存，扫码登录新增「手动检查」` |
| 来源 | GitHub 官方 release tarball `v1.1.7`（tag 指向上述 commit） |
| 随包路径 | `modules/roost-bridge/lib/vendor/roost/` |
| 文件数 | 147（不含本文件与 `SOURCE.sha256`） |

内置副本从上述发版源整份复制，模块胶水**不打补丁、不修改任何 roost 源码**。随包依赖：

- `ws 8.22.2`（`lib/vendor/roost/data/deps/ext/bundled/ws/`，MIT）
- `silk-wasm 3.7.1`（`lib/vendor/roost/data/deps/ext/bundled/silk-wasm/`，按其自带 LICENSE）
- 不含可选 `@ffmpeg-installer`（约 62MB）

## 校验

`SOURCE.sha256` 是本目录全部随包文件的 sha256 清单，路径相对 `lib/vendor/roost/`：

```bash
cd modules/roost-bridge/lib/vendor/roost
sha256sum -c SOURCE.sha256
```

清单自身 sha256：

```text
14e3e50c948713bd901af8ab7e2f6a3fcce649bd2fa6f4ab08a6e766e4d09cc1
```

校验通过才说明随包源码与锁定的 1.1.7 发版一致。

## 自更新说明

roost 原版包含框架自更新能力（`src/updater.js`、`src/services/auto-update.js`），上游默认是：

- `update.autoCheck: true`（每 6 小时只检查并提示）
- `update.autoApply: false`（不自动安装）

我们的集成对运行副本再做一次硬约束：**每次启动前把 `ROOST_HOME/config/bot.json` 的 `update.autoApply` 写回 `false`**；模块胶水不调用 updater，所有下载/安装只在用户于 roost 面板手动确认后由 roost 自身发起。

随包 roost 在自更新/语音等场景可能访问：

- `github.com` / `raw.githubusercontent.com` / `api.github.com`
- `gitee.com`
- `registry.npmjs.org`（或用户在 roost 面板配置的 npm 源）

模块胶水自身只访问 `127.0.0.1` 的 roost 面板 API；扫码协议由 roost 访问 `q.qq.com`。

## 许可证

roost 本体：`AGPL-3.0-only`，见 `LICENSE`。  
本模块整体（含模块胶水与随包 roost）：`AGPL-3.0-only`，见模块根 `LICENSE` 与 `module.json`。  
第三方依赖 `ws` / `silk-wasm` 按各自 LICENSE。
