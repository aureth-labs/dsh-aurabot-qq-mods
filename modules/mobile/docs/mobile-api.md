# 手机端模块协议

兼容参考实现 `D:/Aurabot/release/mobile`（`feat/mobile-app`）的手机协议与网页版，逐项核对见 [mobile-parity.md](mobile-parity.md)。App 设计来自 Emotionana；App 行为和限制沿用参考文档的静态证据，本轮未重新反编译或运行 APK。

模块入口为 [index.mjs](../index.mjs)，协议服务为 [lib/service.mjs](../lib/service.mjs)，传输为 [lib/transport.mjs](../lib/transport.mjs)。安装、HTTPS / Tailscale 步骤及测试命令见 [README](../README.md)。

## 地址与配对

默认关闭。电脑模块面板点击“开启并生成二维码”后，独立监听 IPv4 `0.0.0.0:32180`，端口可改，重启恢复保存的开关。手机通过电脑可达地址访问，不能把手机自己的 `127.0.0.1` 当电脑。二维码为可直接打开的 `http(s)://电脑:端口/?code=...`，网页版自动配对；原 App 的“设置 → 扫码”也读取此格式。网页扫码 / 粘贴另接受 JSON `{"url":"https://电脑:32180","code":"..."}`。

配对码为随机 12 字节的小写 hex（24 字符），五分钟、一次有效，刷新使旧码失效。`POST /api/mobile/pair` 使用 JSON `{"code":"..."}`，不要求旧 token，返回 `{"ok":true,"token":"..."}`。token 为随机 32 字节 base64url（43 字符），每台设备独立，仅 SHA-256 摘要落盘。原 App 的手输“保存”只存设置，不发起 pair，需扫码；网页手输保存会配对。

除 pair 和五个静态资源外，HTTP 必须带 `X-Aurabot-Token: <token>`，无 Bearer 前缀。头像和表情也需鉴权。不接受 query token、配对码代替 token、或 HTTP 用 WS 子协议代替凭据。

WebSocket 地址为 `/api/mobile/events`。App 使用同一请求头；浏览器使用 `Sec-WebSocket-Protocol: aurabot, aurabot.<token>`，服务端仅选择并回传 `aurabot`。无效凭据在升级前返回 401；撤销 / 换主人后连接关闭码 4401。服务端提供心跳、连接数量限制和慢消费者断开。

## HTTP 接口

列表返回根对象包数组。以下路径均在手机独立监听端口，不加 `/aurabot/api` 前缀。

| 方法 / 路径 | 请求 | 响应 |
| --- | --- | --- |
| POST `/api/mobile/pair` | JSON code | token，见上文 |
| GET `/api/mobile/bots` | 无 | `{bots:[Bot]}` |
| GET `/api/mobile/messages` | botId，可选 before 毫秒 | `{messages:[Message]}`，升序，最多 30 条 |
| GET `/api/mobile/sessions` | 无 | `{sessions:[{id,title,subtitle}]}`，真实 DSH sessionId |
| GET `/api/mobile/settings` | 无 | `{wakeWord,ttsPort,version}`，只读 |
| GET `/api/mobile/stickers` | 无 | `{stickers:[{name,url}]}` |
| GET `/api/mobile/sticker/{md5}` | 原库 md5 | 鉴权图片字节 |
| GET `/api/mobile/avatar/{botId}` | 已有聊天 botId | 鉴权头像字节 |
| POST `/api/mobile/send` | JSON 或 multipart，见下表 | 202 `{ok:true}` 表示已接受异步处理 |
| GET `/api/mobile/events` | WebSocket Upgrade | 101；未升级返回 426 |
| POST `/api/mobile/logout` | 当前设备 token | `{ok:true}`，自撤销并断开该设备 WS |

Bot 字段为 `{id,name,avatar,ttsPort?,lastText,lastAt,unread}`。id 为 `c_` + 原 chatId 的 base64url，不是任意可指定的聊天名；只列已有 private/group 会话。无 TTS 端口时省略 Bot.ttsPort，不发 null，以兼容 App 解析。lastAt 为 ISO 时间或 null，unread 初始为 0，网页自行跟踪未读。settings 的 wakeWord 来自 group.wakeWords；ttsPort 只暴露当前配置引擎（cosyvoice/gptsovits/http）的端口，没有则“未配置”，不返回完整 URL 或密钥；version 来自宿主 `api.version`。

| kind | 类型 | 必需字段 |
| --- | --- | --- |
| text | application/json | botId、kind、text（非空，最多 20000 字符） |
| sticker | application/json | botId、kind、sticker（原库名字，无名用 md5） |
| image | multipart/form-data | botId、kind、file；可选 dir |
| voice | multipart/form-data | botId、kind、durationMs（0–120000 整数）、file；可选 dir |

文件上限 10MB，请求体上限 12MB。图片按文件头校验，保留原图后交给 hub 的缩图 / 识图链路。语音支持 PCM WAV、M4A、WebM、Ogg；非 WAV 通过本机 ffmpeg，路径复用本体配置，限定 file/pipe 协议、120 秒和转换超时，临时目录处理后删除。网页丢弃 800ms 以下录音，最多录 120 秒并支持取消。上传文件名不作为电脑路径。

dir 留空使用 `modules-data/mobile/downloads/`，或填其下相对目录（如 `phone/photos`）。最长 160 字，每段最多 64 字，拒绝绝对路径、盘符、反斜杠、穿越、空段、尾随点 / 空格和 Windows 保留设备名。文件名由模块生成，原字节保留供主人清理，不额外提供文件下载路由。

send 校验后立即 202，避免原 App 20 秒读取超时；每设备最多一条、全局四条在途输入。转换 / 识别 / hub 接收失败通过 system 事件提示，不自动重发。重启可能丢失在途输入，无独立手机消息队列。输入以主人身份交给已有聊天，保留白名单、总开关、暂停、群聊 social 权限、即时记忆、原话档案、既有会话和 QQ 回复出口；转写、缩图和异步 prompt 准备后重新鉴权，撤销期间不再交给模型。

## 流水、历史与实时事件

消息格式：

```json
{"type":"message","id":"稳定的24位hex","botId":"c_cHJpdmF0ZToxMDAwMQ","kind":"text","text":"在呢","imageUrl":null,"url":null,"durationMs":0,"mine":false,"at":1767254400000}
```

kind 使用小写 text / sticker / system 等，App 转大写匹配枚举。mine 表示主人输入，bot 回复始终为 false。id 由流水字段计算，同一记录用于历史和实时回放。手机来源流水经 `via:'mobile'`、仅实时携带的 `originId` 排除当前发送设备的回声，其他设备仍接收；来源设备标记不落盘。

`chat/log` 是成功写入原流水后的通知。正常模型回复和 `api.send` 经 `hub.deliver()` 统一记账，模块监听同一份流水；底层 `sendText/sendSegments` 本身不新增流水。没有另建聊天 / 记忆副本，原流水仍脱敏并截为最多 500 字；调试模式不落盘、不发此事件。

历史接口跨所有保留日志日读取，只返回指定已有聊天的数据。无 before 取最近 30 条；有 before 取 `t < before` 中最近 30 条，下一页使用本页第一条 at。非法 before 返回 400，无此会话 404。事件新连接回放近七个日志日中最后最多 64 条可见消息；网页使用事件 ID 与时间水位去重，避免旧回放增加未读 / 通知。

展示过滤已忘记、系统流水、记忆提示和 seen 资料。唯一匹配原库的 `[表情：名字]`、`[表情] 名字`、md5 / 八位前缀可恢复受保护的表情 URL。旧图片 / 语音流水只有占位或转写时回退 text，不能恢复原字节。网页可显示带 URL 的鉴权媒体和当前上传的本地预览。原 App 事件解析漏填 imageUrl，语音播放器未带 token，仍需 App 协作者修正，不能以匿名下载或 URL token 绕过。

## 网页与通知

静态 GET `/`、`/mobile.js`、`/sw.js`、`/manifest.webmanifest`、`/icon.svg` 无须 token，仍受开关、网络和来源检查。页面资源由模块 `assets/web/` 提供，清单和图标由服务生成。所有响应保持 no-store、nosniff 和与参考相同的 CSP。运行时脚本不使用 CDN 或第三方配对 / 识码服务。

保留聊天 / DSH / 设置、搜索、刷新 / 下拉、Bot 切换、独立草稿、历史翻页、未读、表情面板、图片全屏、单播放器、上传目录、连接测试、扫码 / 粘贴、退出配对。DSH 页只列原会话，可拖动吸边球刷新；没有任意 DSH 会话发送协议。

普通 HTTP 可聊天、发图和表情；录音、相机和系统通知需要浏览器信任的安全上下文。网页明确提示去面板配置 HTTPS。BarcodeDetector 不可用时可用系统相机扫同一二维码直接打开，或粘贴内容。更换电脑地址会导航到该来源，旧 token 不随跨来源请求传送。token 仅存在当前来源 localStorage，鉴权媒体通过同源请求转 blob 使用。

后台存活页面收到她的新消息时通知，标题 Bot 名、正文最多 80 字，过滤本人 / system / 重复事件。用户点击按钮申请权限，优先 worker.showNotification，无 worker 的桌面回退 Notification。worker 只负责通知点击、聚焦 / 打开对应 botId，无 fetch 拦截、CacheStorage 或 token。冻结 / 关闭网页后无离线 Web Push；iOS 通知受系统版本和主屏幕安装限制。

切 Bot、切后台、pagehide 取消录音 / 扫码并释放轨道，权限弹窗期间松手不会启动迟到录音；退出配对还断 WS、停止播放、释放媒体和通知、清理 token / 草稿 / 未读 / 事件水位，保留本来源上传目录偏好。

### 在「Aurabot 手机端」安卓 App 里

App 是这个网页的壳，不另有一套协议。局域网 http 地址由 App 在手机本机 `127.0.0.1:38417` 开 TCP 原样转发到电脑，WebView 打开本机地址：本机地址算安全上下文，录音直接可用；Host 与 Origin 都是 `127.0.0.1:38417`，服务端的同源检查照常成立。https 地址直接打开。

App 向页面注入 `window.AuraNative`，页面检测到它时改走原生：

| 方法 | 作用 |
| --- | --- |
| `serverOrigin()` | 真实电脑地址，用于显示和比较（页面自身来源固定是本机） |
| `changeServer(href)` | 换电脑：App 先清空本机所有网页存储（含 token、草稿），再打开新地址，旧 token 不会发往新电脑 |
| `scan()` | 原生扫码，结果按同一二维码格式处理 |
| `notify(title, body, botId, id)` | 系统通知，点击回到对应 Bot |
| `notificationStatus()` / `requestNotifications()` | 通知状态文字、申请或跳转系统设置 |

App 只在自己的电脑地址内导航，其他链接交给系统浏览器，原生接口不会暴露给别的页面。没有 `AuraNative` 的普通浏览器行为不变。

## 电脑管理与数据

五条管理路由只在宿主面板端口：

- GET `/aurabot/api/ext/mobile/status`
- POST `/aurabot/api/ext/mobile/pairing`
- POST `/aurabot/api/ext/mobile/configure`
- POST `/aurabot/api/ext/mobile/revoke`，JSON id
- POST `/aurabot/api/ext/mobile/disable`

它们通过通用 `api.route(..., {access:'panel'})` 复用宿主回环 / 可信代理、Host 和 CSRF 管理闸。参考内置版的 `/aurabot/api/mobile/*` 管理路径已迁到模块命名空间；手机端 `/api/mobile/*` 保持原协议。设备管理不能通过手机独立端口调用。

设备元数据、token 摘要、主人身份和连接选项仍在 `modules-data/mobile/devices.json`，沿用参考格式与目录，可保留旧配对；只落盘摘要，不存明码或聊天 / 记忆副本。模块用同目录临时文件 + rename 保存。关闭 / 卸载 / 重载释放监听，换主人撤销全部旧设备。请勿同时运行原内置版与本模块。

默认网络范围为实际 socket 的回环、RFC1918 IPv4、IPv6 ULA / link-local；不信任代理头来冒充 LAN。公网 / 代理来源须在模块面板开启远程、确认风险并填可信 HTTPS 地址；手机远程开关与本体面板远程开关独立。浏览器跨站 Origin 和 Sec-Fetch-Site: cross-site 被拒绝；远程明确开启后允许配置 publicUrl 的来源用于反代。

TLS 证书 / 私钥须同时配置，先验证可读、PEM 与匹配再保存，最低 TLS 1.2，同路径续期后重新应用可重载。Tailscale 的 100.64.0.0/10 不属于默认 LAN 范围，需远程确认。完整步骤见 [README](../README.md#https-与-tailscale-证书) 和面板。原 APK 的明文策略、自签名信任及远程媒体兼容性仍须真机联调。

错误响应为 `{ok:false,error,message}`：400 参数 / 格式，401 凭据，403 配对码拒绝 / 网络或跨站限制，404 会话 / 素材 / 接口不存在，405 方法，413 大小，415 内容类型，426 未升级，429 限流 / 忙，503 未启用 / 未就绪。网页显示具体 message；未知内部异常不暴露电脑路径或栈。

测试命令见 [README](../README.md#测试)，覆盖实际社区模块装载、HTTP / WS、主人身份、记忆与媒体、设备撤销 / 重启、管理闸、网页录音 / 草稿 / 通知。用户上一轮报告模块 29 项通过，模块库检查通过；本轮未运行命令或真机验证。
