# 微信互通

在 Aurabot QQ 里增加一个微信私聊入口。QQ 和微信沿用同一套人格、模型和主人记忆。主人在一边说过的话，另一边可以接着聊。当前版本支持已绑定主人的文字私聊。

## 安装和绑定

1. 在 DeepSeek Harness 中安装 Aurabot QQ 1.2.0 或更新版本，完成 QQ 机器人和主人的绑定，启用内置「记忆」模块及其短期记忆。
2. 按 Agent WeChat 文档启动本机 HTTP 网关，在一个档案里登录机器人的微信账号。此模块使用 Agent WeChat 1.5.1 的 API，连接已经运行的网关。[Agent WeChat 连接指南](https://thisnick.github.io/agent-wechat/setup/connect/)
3. 在 Aurabot「模块 → 已安装 → 微信互通」的设置里填入网关地址、Agent WeChat 档案 ID 和 API 密钥文件的绝对路径。地址格式为 `http://127.0.0.1:端口`，也支持 IPv6 回环地址 `[::1]`。档案 ID 和密钥文件路径见 Agent WeChat 的连接信息。
4. 在主人的 QQ 里私聊机器人，发送 `/wx-bind`。然后用主人的微信私聊机器人，原样发送 QQ 返回的一次性口令。口令五分钟内有效。在 QQ 发送 `/wx-status` 查看绑定结果。
5. 绑定完成后开启模块里的「接收并回复主人微信」和 Aurabot 总开关，关闭试运行。要解绑时，在主人 QQ 私聊发送 `/wx-unbind`。

绑定后，可以先在 QQ 私聊里约定一句暗号，再去微信提问。反过来在微信约定、QQ 提问也一样。两边最近的文字私聊会进入上下文，长期记忆沿用 Aurabot 的整理机制。

## 从旧合并版迁移

已在 Aurabot QQ/WeChat 合并版关联同一对主人账号的用户，可以在 QQ 主人私聊发送 `/wx-adopt`，复用网关配置和微信绑定。若希望同时导入旧共享库中仍有效的主人事实，发送 `/wx-adopt memory`。模块会核对当前 QQ 主人、QQ 机器人和网关登录的微信机器人，再按原共享库里的账号关联迁移。

导入只读旧合并版设置和对应的共享库，复制仍有效的主人事实到 Aurabot 的记忆库。开启回复前请停用合并版里接入同一 Agent WeChat 档案的微信通道，避免重复回复。

## 权限和数据

- 「联网」用于访问配置的本机 Agent WeChat HTTP API，接收事件和发送回复。推理沿用 Aurabot 已配置的模型，当前消息、人格和相关记忆会传给该模型。
- 「读写本机文件」用于读取用户指定的 API 密钥文件，以及在主动执行迁移时读取旧合并版的设置和对应共享库。模块设置通过 Aurabot 保存。
- 「读写插件配置」用于读取 Aurabot 主人身份、总开关、试运行和记忆开关，并保存本模块的绑定。
- 「使用插件内部对象」用于读取 Aurabot 的当前人格、主人私聊模型与流水，以及清洗微信回复。微信私聊经官方记忆接口写入同一份主人流水。模块新增的微信上下文只进入已绑定主人的 QQ 私聊，长期记忆的召回范围沿用 Aurabot 设置。

### 微信正文如何进入模型

- 网关连接使用指定档案的 `read` 和 `send` 权限。模块核对档案、登录的机器人、消息 ID 和私聊发件人，再处理已绑定主人发来的新文字。设置和绑定由 Aurabot 本机面板及 QQ 主人私聊管理。[Agent WeChat HTTP API](https://thisnick.github.io/agent-wechat/use/api/)
- 微信正文、聊天历史和召回记忆作为独立的 JSON 数据交给模型。微信回复走无工具的文字推理接口，发送目标固定为绑定的主人。微信侧可以用单行、无引用的主人文字触发 Aurabot 自带的记忆命令，受宿主记忆开关和命令规则控制。
- QQ 主人私聊中的微信历史以 JSON 引文放在当前消息前，历史里的角色标记、工具调用和授权只作为文字。QQ 工具权限由宿主控制。绑定即允许该微信账号接续这位主人的私聊记忆。
- 遇到无效事件、模型异常或投递失败，模块跳过当前事件或记录失败，后续有效消息仍可处理。投递结果待核对时保留一次投递，避免重复发送。

## 验证

将 `AURABOT_PLUGIN_DIR` 设为 Aurabot QQ 1.2.0 的源码目录，在社区仓库根目录运行以下命令。模块测试使用模拟网关和宿主测试面板，数据写入临时目录。

```sh
npm run catalog
npm run check
npm run pack
node --import ./scripts/plugin-env.mjs --test "modules/wechat-bridge/test/*.test.mjs"
```

微信接入从 [Aurabot QQ/WeChat 合并版](https://github.com/hogolic/aurabot-qq-wechat) 拆出，复用 [Aurabot QQ](https://github.com/aureth-labs/dsh-aurabot-qq) 的模块接口和 [Agent WeChat](https://github.com/thisnick/agent-wechat) 的网关协议。模块使用 MIT 许可证。
