# 手机端模块功能对照

逐项对照 `D:/Aurabot/release/mobile`（`feat/mobile-app`）的 `docs/mobile-parity.md`、`src/modules/mobile/`、`client/client.js` 中的 `MobilePanel`，核对本模块与 `D:/Aurabot/release/core-hooks` 的通用接口。下表保留参考表 01–44 的编号，结论均为源码静态核对；本轮没有运行测试、浏览器或 APK。App 设计署名 Emotionana；App 行为依据沿用参考文档，本轮没有重新反编译。

实现位置：

- W：[assets/web/index.html](../assets/web/index.html)
- J：[assets/web/mobile.js](../assets/web/mobile.js)
- SW：[assets/web/sw.js](../assets/web/sw.js)
- B：[lib/service.mjs](../lib/service.mjs)，音频为 [lib/audio.mjs](../lib/audio.mjs)
- P：[panel.js](../panel.js)，入口为 [index.mjs](../index.mjs)

“保留”指参考网页版已有的行为在模块中仍有实现，不表示与原生 App 的平台能力完全相同。

| ID | 参考功能 / 交互 | 模块核对结果与位置 |
| --- | --- | --- |
| 01 | 聊天 / DSH / 设置三标签，不滑动切页 | 保留：W 三个 home view 和 tabs，J 标签点击；仅聊天保留边缘返回手势。 |
| 02 | 聊天列表、进入对应 Bot | 保留：W `loadBots/renderList/openChat`，B `/bots`。 |
| 03 | 刷新按钮、下拉刷新、返回列表重载 | 保留：W back，J `refreshBots/pullToRefresh`。 |
| 04 | 加载、空列表、连接错误、重试 | 保留：W `listStatus`、空页及刷新入口。 |
| 05 | 名称、最后消息、时间、99+ 未读 | 保留：W `renderList/push`，J `saveUnread`、持久化事件 ID 和时间水位。 |
| 06 | 鉴权头像、缓存、失败占位 | 保留参考差异：W `authed/setAv` 使用 blob 内存缓存及首字占位，退出释放；不是 App 的永久磁盘缓存。B 通过通用 `media.avatar()` 读字节。 |
| 07 | 聊天返回按钮 | 保留：W back 和边缘右滑。 |
| 08 | 点标题 / 下拉切换 Bot | 保留：W botDialog/botSwitcher/botDropdown，J `showBots`。 |
| 09 | 名称、在线状态、可选 TTS 端口 | 保留：J `updateChatSubtitle`，B `mobileTtsPort` 与 Bot 可选整数 `ttsPort`。 |
| 10 | 切换会话提示 | 保留参考差异：W `openChat` toast，不将提示写进聊天流水。 |
| 11 | 每 Bot 独立草稿、恢复、发送清空 | 保留：W `text.oninput/openChat/composer`，本来源 localStorage。 |
| 12 | 空白不发送，有文字显示发送，否则麦克风 | 保留：W composer 与输入事件，HTTP 下仍显示录音入口。 |
| 13 | 按钮 / 输入法发送、本人气泡、失败提示 | 保留参考差异：W composer；手机点击按钮，桌面 Enter 发送、Shift+Enter 换行，输入法组合期间不发送。 |
| 14 | 实时事件按 botId 过滤、滚动 | 保留：W `connect/push/renderMsgs`，旧 socket 回调隔离、近底部滚动、新消息跳转。 |
| 15 | 本人 / 她的气泡、文字 / 系统消息 | 保留：W `bubble/esc`，文字转义。 |
| 16 | 图片按钮、选择、上传、本地预览 | 保留：W file + multipart，附 dir；B 保存原字节，调用通用 `receiveOwnerMessage` 识图。 |
| 17 | 点图片全屏，再点关闭 | 保留：W viewer。 |
| 18 | 表情底部面板、加载 / 空库 / 错误 | 保留：W sheet/stkBtn/closeStickers，关闭后可重试。 |
| 19 | 表情网格、鉴权缩略图、名字 | 保留：W sticker-choice 与 `authed`；B 通过 `media.sticker(md5)` 读原库字节。 |
| 20 | 按名字发送表情、关闭面板、本人气泡 | 保留：W stickers callback，异步下载前捕获目标 Bot。 |
| 21 | 麦克风授权、按住开始、松开发送、提示 | 保留：J micBtn；HTTP 提示 HTTPS，不申请不可用的麦克风。 |
| 22 | 800ms 门槛、时长、AAC/M4A 上传 | 保留参考差异：J 按浏览器能力录 WebM/M4A/Ogg；800ms、120s、10MB、取消及授权期间松手清理。B/audio 保留 App M4A 与 WAV 解码，使用通用媒体辅助。 |
| 23 | 点击语音播放、换条释放旧播放器 | 保留：W `playVoice/stopPlayback`，鉴权下载、暂停、结束 / 错误复位。 |
| 24 | 系统通知授权 | 保留参考差异：J 用户点击 `enableNotifications` 时申请；HTTP、不支持和拒绝均提示。 |
| 25 | 她的新消息通知、Bot 标题、80 字正文 | 保留：W push，J `notifyMessage`，优先 worker；过滤 mine/system 与重复回放。仅后台页面仍能接收 WS 时成立。 |
| 26 | 点击通知进入 botId、通知自动取消 | 保留：SW notificationclick 聚焦 / 开窗，J `openNotificationChat`，桌面无 worker 回退。 |
| 27 | DSH sessions、标题 / 副标题 / id 回退 | 保留：J `loadSessions`，B `/sessions` 返回真实 DSH sessionId。 |
| 28 | DSH 连接 / 数量 / 空页 / 错误 / 下拉刷新 | 保留：J `loadSessions/pullToRefresh`，W dshStatus/sessions。 |
| 29 | DSH 球点击刷新、拖动限界、吸边半隐藏 | 保留：J dshBall pointer handlers，W ball 样式。 |
| 30 | 电脑地址设置与保存 | 保留参考差异：J `goToServer/serverOrigin` 导航到对应来源，地址由浏览器保存，旧 token 不跨来源发送。 |
| 31 | 配对码输入和保存 | 保留参考差异：W 配对 / 设置表单，J 保存时真正 pair，用后清空一次性码。 |
| 32 | 设置扫码、相机 QR、取消不改设置 | 保留参考差异：J BarcodeDetector + getUserMedia，取消停止相机；不支持时用系统相机或粘贴。 |
| 33 | JSON {url,code} / URL ?code、错误提示 | 保留：J `parsePairing/applyPairing`，检查 http(s)、凭据和非空码。 |
| 34 | 扫码自动配对、token 持久化、成功 / 失败 | 保留：W `pair/start`，J boot；URL、粘贴、相机共用流程，尝试前移除地址栏配对码。 |
| 35 | 上传目录保存、图片 / 语音 multipart dir | 保留参考差异：J 本来源偏好；W/J multipart；B `mobileUploadDir` 只允许模块 downloads 下相对目录。 |
| 36 | 保存、测试连接、重读服务器信息 | 保留：J settingsForm/testConnection/loadServerInfo，显示状态及原因。 |
| 37 | 只读唤醒词 / TTS、读取失败 | 保留：J `loadServerInfo`，B settings 读实际配置端口，不返回密钥或完整 TTS URL。 |
| 38 | 表情库数量与失败状态 | 保留：J `loadServerInfo` 读取 stickers 数量，失败有明确状态。 |
| 39 | 版本信息 | 保留：B settings 从宿主 `api.version` 取得版本，J versionInfo；W 保留 Emotionana 署名。 |
| 40 | token 持久化、401 / 403 / 404 / 429 / 5xx 提示 | 保留：W api 使用服务端 message，401 logout；HTTP 请求头和 WS 子协议鉴权。 |
| 41 | 生命周期释放录音 / 事件资源 | 保留参考差异：J/W 切 Bot、后台、pagehide 取消录音 / 扫码；退出断 WS、释放播放和 blob；后台保留 WS 用于通知。 |
| 42 | 有 URL 时图片 / 语音、历史原媒体 | 保留参考限制：W 支持鉴权 URL 和本次上传的本地播放；B 原流水只含占位 / 转写时回退 text，不伪造媒体 URL；唯一匹配原库的表情可恢复。 |
| 43 | 退出配对 | 保留：J logoutBtn；B POST `/api/mobile/logout` 自撤销并关闭该设备 WS；W 清理本来源数据。 |
| 44 | HTTP 提示 HTTPS、面板证书路径、Tailscale 步骤 | 保留：W/J 提示；P 证书 / 私钥框及六步说明；B 保存前验证可读 / PEM / 匹配，支持同路径重载。 |

参考电脑面板也逐项核对：

| 项目 | 模块实现 |
| --- | --- |
| 开关、状态、会话数、监听错误、无聊天提示 | P 手机端卡片；保留开启 / 刷新二维码 / 关闭按钮，另有总开关；监听失败后也可关闭已保存的开关。 |
| QR、地址、配对码、过期倒计时、可复制 payload | P pairing 展示，与参考一致；B 仍为五分钟一次有效，刷新失效旧码。 |
| 设备列表与逐台撤销 | P devices，B revoke；HTTP 与 WS 使用同一撤销状态，换主人清空旧设备。 |
| 端口、可达地址、多网卡地址 | P form，B status/configure，保留物理网卡优先排序。 |
| TLS 路径、HTTP 提示、Tailscale 六步与续期 | P 全部保留，B 先校验后保存，TLS 最低 1.2。 |
| 远程开关、风险勾选、应用设置 | P risk/form，B 验证确认与 HTTPS 地址；五条管理路由声明 `{ access: 'panel' }`，复用宿主管理闸。 |

迁移差异：内置导航页变为模块自带面板；管理地址从 `/aurabot/api/mobile/*` 改为 `/aurabot/api/ext/mobile/*`，手机独立端口的 `/api/mobile/*` 不变。运行时不再相对导入本体源码：头像 / 表情 / ffmpeg / WAV 经 `api.core.media`，版本经 `api.version`，主人输入经通用 hub API；`mobileDevice` 改为仅实时的 `originId`，并以 `via: 'mobile'` 限定来源端去重。devices.json 格式及数据目录保留，改由模块自身临时文件 + rename 保存。模块默认关闭，安装、停用、热重载跟随模块生命周期。

本轮发现的迁移遗漏是 README 链接的协议与对照文档未随模块建立，现已补齐；44 项及上述面板入口未发现功能缺项。此结论只覆盖源码与发布规则的静态核对，不是浏览器视觉或真机验收。网页 / 通知 worker 的实现与参考逐段核对相同；协议与安全限制亦保留。

固有边界仍包括：网页冻结 / 关闭后无离线 Web Push；部分浏览器不支持 BarcodeDetector；iOS 通知依赖系统版本和主屏幕安装；旧流水缺少原媒体字节无法恢复；原 APK 远程媒体鉴权及 HTTP / 证书兼容性需真机联调。上传目录仍限制在 downloads 内。原 App 的 DSH 仅列会话，TTS / 唤醒词只读，模块沿用。

验证入口见 [README](../README.md#测试) 与 [协议](mobile-api.md)。用户上一轮已报告模块 29 项通过、模块库检查通过；本轮修改后尚待用户重跑，没有据此宣称新一轮测试通过。
