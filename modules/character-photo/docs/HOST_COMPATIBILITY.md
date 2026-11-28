# 模拟人生与官方 Aurabot 1.3.0

本页面向在其他设备安装模块的维护者。核对基线为 2026 年 11 月 27 日发布的 v1.3.0，源码提交 `14ffe5b6b174fec4566e04af6a0da431341064e2`。模块安装和宿主更新各有自己的发行与加载过程。[官方发行页](https://github.com/aureth-labs/dsh-aurabot-qq/releases/tag/v1.3.0)

## 参考图与画风

官方生图服务支持单图、多图、显式像素尺寸，以及查询当前接法的参考图上限。参考图张数、可用尺寸和返回格式随实际配置变化。原版会给参考图编辑请求也加上全局画风，例如把「全局水彩」加到服装三视图的制图指令前。全局画风留空时可直接使用接法自身支持的参考图编辑。[1.3.0 生图服务](https://github.com/aureth-labs/dsh-aurabot-qq/blob/14ffe5b6b174fec4566e04af6a0da431341064e2/src/features/imagegen.js)

本地候选补丁增加 `supportsReferenceStyle` 能力标记和单次 `generate(prompt, { images, styleMode: 'reference' })`。这次编辑沿用原图与调用方的制图说明，普通生图继续使用全局画风。补丁保留参考图开关和供应商限制。修补范围仅为生图服务及其回归用例。[参考画风补丁](reference-style-v1.3.0.patch)

1. 取当前实际加载的官方 v1.3.0 源码副本，保留原件。用 `git hash-object --no-filters src/features/imagegen.js` 核对基线 `2034c45816d6ee3dcb78864df67cb304ebc410d3`。已定制或更新的发行版应先比对该功能。
2. 在副本根目录运行 `git apply --check <补丁路径>`，通过后运行 `git apply <补丁路径>`，再运行 `node --test test/imagegen-reference-style.test.js`。按设备通常的插件更新流程加载这个版本。需要撤回时可恢复原包，或在同一副本运行 `git apply --reverse <补丁路径>`。
3. 隔离测试检查了服饰转换原样发送两张参考图、普通编辑及文生图的默认画风、错误参数在调用供应商前停止。相关 92 项测试通过，使用模拟图片接口。实际模型的画面质量由安装设备使用其生图配置验收。[校验值及正反向还原](verification.json)

## 完整互动所需的宿主能力

| 接入点 | 上游可提供的合同与验收 |
| --- | --- |
| 记忆接管、角色与会话归属 | 目前已合入原生记忆只读预览与私聊送达回执。增强记忆仍需要接管、交回、遗忘、重开及迟到事件隔离。用同一 QQ 切换两个角色，验证重置 A 后 B 的存档可继续使用。已有追踪可直接接续。[已合入 #465](https://github.com/aureth-labs/dsh-aurabot-qq/pull/465) · [接管 #445](https://github.com/aureth-labs/dsh-aurabot-qq/issues/445) · [会话归属 #466](https://github.com/aureth-labs/dsh-aurabot-qq/issues/466) |
| 恋爱自动结算与心情 | 在真实发送成功后提供归属、稳定消息编号、当轮原生心情结果。关系服务按已确认的主人私聊做一次判定。撤回、相同回执重放、独立模块移除和进程重启均应可复验。原生记忆的私聊回执只覆盖其中一环。[送达接口的上游边界](https://github.com/aureth-labs/dsh-aurabot-qq/pull/465) |
| 生活与见面状态进入聊天、睡眠及主动联系 | Aurabot 提供聊天归属和已送达来源，DSH 在指定会话的模型请求前调用投影；工具回合和压缩后仍保留对应人格的上下文。新建记录、睡眠暂存和再唤醒应按人格及代际验证。需要 Aurabot 与 DSH 两侧协作。[请求前投影的既有议题](https://github.com/aureth-labs/dsh-aurabot-qq/issues/445) |
| 空间日记配图与顶栏 | 日记端应提供带人格标记的草稿、选图、确认发布及撤销入口，发布前再次核验受众与素材。客户端应从当前运行人格取得阶段摘要，关系暂停或尚未建档时隐藏徽标。宿主应让合并后的提供方通过有权限约束的接口接入，保留独立安装的提供方优先级。[官方日记模块](https://github.com/aureth-labs/dsh-aurabot-qq/blob/14ffe5b6b174fec4566e04af6a0da431341064e2/src/modules/diary/index.js) · [官方客户端](https://github.com/aureth-labs/dsh-aurabot-qq/blob/14ffe5b6b174fec4566e04af6a0da431341064e2/client/client.js) |

本次画风补丁独立验证。上表其余能力需要对应宿主或 SDK 提供并逐项验收；市场模块的安装成功只确认模块程序已加载。
