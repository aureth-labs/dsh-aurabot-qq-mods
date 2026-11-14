# 手机端

手机扫码连上 Aurabot，在她原来的会话里聊天、发图、发表情和语音，共用会话、流水和记忆；她的回复仍会发到原 QQ 聊天。模块提供独立端口的网页版，也兼容安卓 App 的协议。默认关闭，安装后由主人在模块面板开启。

**界面和功能设计来自 Emotionana 的安卓 App**。网页版保留参考实现的 DSH 配色、玻璃顶栏、主角卡片、深浅色和聊天气泡。作者：Emotionana, Aurabot。

## 安装与使用

1. 使用 Aurabot **1.3.0 或更新版本**，在「模块市场」安装「手机端」。本模块是可选社区模块，不会随本体内置加载。手动安装时，将整个文件夹放到插件数据目录 `modules/mobile/`，不要只复制入口文件。
2. 启用本体并设置主人 QQ，先从 QQ 给她发一句话，建立原有聊天。打开模块自带的「手机端」面板。
3. 电脑和手机连接同一局域网，点击「开启并生成二维码」。默认监听 IPv4 `0.0.0.0:32180`；必要时在电脑防火墙允许该端口的专用网络入站。
4. 手机系统相机扫码，浏览器打开后自动配对，可添加到主屏幕；安卓 App 可在「设置 → 扫码」使用同一二维码。App 当前手输“保存”不会发起配对，请用扫码。
5. 多网卡时优先选择 Wi-Fi/以太网，热点、虚拟网卡和 VPN 后排；如果自动地址不通，在「手机可达地址」填正确的 `http(s)://主机:端口`，应用后刷新二维码。刷新使旧码作废，配对码五分钟内一次有效。
6. 丢失或不用的设备在「已配对设备」点「撤销」；手机设置里的「退出配对」只撤销当前设备。关闭手机入口会停止监听，卸载/关闭模块也会释放监听。更换主人 QQ 自动撤销旧设备。

聊天、DSH、设置三页包含会话列表/搜索/下拉刷新、Bot 切换、独立草稿、历史翻页、未读、鉴权头像/表情、图片预览、按住录音、语音播放、相机/粘贴二维码、连接测试、上传目录、只读唤醒词/TTS/版本和系统通知。DSH 页与 App 一样展示现有会话列表，悬浮球可拖动吸边、点击刷新。

## HTTPS 与 Tailscale 证书

普通 HTTP 可聊天、发图和表情。浏览器录音、相机、系统通知需要受手机信任且域名匹配的 HTTPS。安卓 App 也可能拒绝 HTTP 或自签名证书。

1. 电脑和手机安装 Tailscale，登录同一 tailnet 并保持在线。在管理台 DNS 启用 MagicDNS 和 HTTPS certificates。
2. 在电脑证书目录运行 `tailscale cert 电脑名.tailnet名.ts.net`。请使用电脑实际的完整域名，生成同名 `.crt` 和 `.key`。
3. 在模块面板填写两个文件的绝对路径，例如 `C:\Aurabot\certs\电脑名.tailnet名.ts.net.crt` 和 `.key`；「手机可达地址」填 `https://电脑名.tailnet名.ts.net:32180`。必须使用证书域名访问，直接用 IP 不匹配证书。
4. Tailscale `100.64.0.0/10` 不在默认 LAN 范围，打开「允许远程访问」、勾选风险确认，再「应用连接设置」。防火墙和 tailnet ACL 只放行所需设备到该端口，无需公网端口映射。
5. 刷新二维码，手机重新打开 HTTPS 地址并配对；允许麦克风和通知。iPhone/iPad 的系统通知需先添加到主屏幕后打开。
6. 到期前重新运行 `tailscale cert`，同路径替换文件后再次「应用连接设置」以重载。不要粘贴私钥内容到网页。

证书与私钥必须同时填写；先校验可读、PEM 格式和匹配，再保存和重启，最低 TLS 1.2。两项一起清空可恢复 HTTP。也可用可信 HTTPS 反代，转发 HTTP 和 WebSocket Upgrade；公网/代理来源仍必须显式允许远程。

每台配对设备都具有主人身份，可读取聊天并指挥她操作电脑，请保护设备和令牌。远程开关与本体的面板远程管理开关互相独立。设备管理路由只在本体面板端口上，通过通用 `{ access: 'panel' }` 复用本体的管理闸。

## 数据和本体接口

最低版本字段为 `minPluginVersion: 1.3.0`。所需接口必须包含：

- `api.on('chat/log', fn)`：成功落盘后的流水通知，包括她的每条回复；支持仅实时携带的 `originId`。
- `api.core.hub.receiveOwnerMessage(chatId, { text, image, wav, via, originId, assertAuthorized })`：按已有会话接收经过鉴权的主人输入，沿用权限、识图、转写、记忆、原话档案和 QQ 出口；异步准备后重查身份。
- `api.core.hub.sessions()`、`chatLogDays()`、`chatLogOf(day)`：已有会话和原流水。
- `api.core.media`：`mimeOf`、`avatar`、`sticker`、`ffmpegPath`、`parseWav`、`toMono16k`。
- `api.route(path, handler, { access: 'panel' })`：通用管理路由保护。
- 已有 `api.config`、`api.use('stickers')`、`api.route`、`api.onDispose`、`api.version`、`api.dataDir`、`api.log` 和 `api.core.http`。

早期 1.3.0 beta 如果尚未包含这些接口，需要更新本体。模块不使用 `api.lib` 或相对路径导入本体源码。

设备摘要、元数据和连接选项仍保存在插件数据目录 `modules-data/mobile/devices.json`，与原内置实现相同，可保留旧配对；不保存原 token 或配对码。聊天和记忆不另建副本。原内置版与本模块不要同时运行，二者使用同一数据目录/端口。

图片/录音原文件保存在 `modules-data/mobile/downloads/`；手机设置的目录仅是它下面的相对目录，例如 `phone/photos`，拒绝绝对路径与穿越。文件名由模块生成，需主人自行清理。语音转换临时文件在 `uploads/`，转换后删除。本体本地 ASR 的输出沿用其原有保留规则。

## 能力和网络去向

`network`：监听手机连接，不连接第三方配对/识码服务；`filesystem`：模块设备/上传文件、主人配置的证书与私钥；`process`：调用本机 ffmpeg 解码 M4A/WebM/Ogg，路径复用现有配置；`plugin-config`：读取主人、唤醒词、TTS 和 ASR 配置；`plugin-internals`：使用文档公开的 `api.core` 能力。头像和表情从本体 API 取得字节，手机必须鉴权下载。语音识别和模型请求复用本体已配置服务，不增加额外云服务或 CDN。

## 兼容边界

- 浏览器冻结/关闭网页后，WebSocket 不能持续接收通知；Service Worker 只处理通知点击，不提供离线 Web Push，不缓存 token、聊天或头像。
- 不支持 BarcodeDetector 的浏览器可用系统相机扫码，或粘贴二维码文字。
- 旧流水只存占位/转写，没有原图和语音文件地址，无法恢复原媒体；能匹配原表情库的记录仍可显示表情。
- 原安卓 App 的远程媒体鉴权和 HTTP 策略仍需真机联调，不用 query token 或匿名媒体下载绕过。

协议见 [docs/mobile-api.md](docs/mobile-api.md)，44 项功能对照见 [docs/mobile-parity.md](docs/mobile-parity.md)。

## 测试

在模块库根目录运行（Node.js 22.2+，本体路径必须指向包含上述接口的源码）：

```powershell
$env:AURABOT_PLUGIN_DIR = 'D:/Aurabot/release/core-hooks'
node --import ./scripts/plugin-env.mjs --test modules/mobile/test/*.test.mjs
npm run check
npm run pack
```

本体工作树新增测试：

```powershell
node --test test/module-chat-api.test.js test/module-media-api.test.js test/module-panel-route.test.js
```

测试宿主通过仓库的 `scripts/plugin-env.mjs` 取得，HTTP/WS 集成测试将本模块实际复制到隔离数据目录并加载为 user 模块；不会接真实 QQ 或手机。本轮按要求未运行命令、测试或真机验证，未提交。
