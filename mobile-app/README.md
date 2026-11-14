# Aurabot 手机端（Android）

Aurabot「手机端」模块的安卓伴侣应用，将局域网或 Tailscale 中的 Aurabot 网页端装进独立的原生壳里，补全局域网 HTTP 下的录音、离线扫码与本地消息通知体验。

- 包名：`com.aureth.aurabot.mobile`
- 版本：`0.1.0`（`minSdk 26` / `targetSdk 34`，兼容 Android 8.0 及以上）
- 实现：Kotlin + 原生 View + Android System WebView（无 Compose / 第三方桌面框架）

## 使用步骤

1. 在电脑端启动 Aurabot（`1.3.0+`）与「手机端」模块，打开面板进入「手机端」，点击「开启并生成二维码」（默认监听 `32180` 端口，确保手机与电脑处于同一局域网或 Tailscale 网络）。
2. 安装并打开本应用，点击 **「扫码配对」** 扫描面板二维码即可直接进入聊天；如需手动输入，可展开下方的 **「粘贴链接或二维码内容」**，粘贴 `http(s)://电脑地址:端口/?code=…` 或 `{"url":…,"code":…}`。
3. 连不上电脑时会显示状态页，可直接点击 **「重新连接」** 或 **「换一台电脑」** 重新配对。

## 核心机制

### 1. 局域网 HTTP 语音直通（`Forwarder.kt`）
浏览器在局域网明文 `http://` 下不属于安全上下文，会禁用麦克风录音。当配对地址为 `http://` 时，应用仅在手机本机回环地址 `127.0.0.1:38417` 启动一个纯 TCP 字节流转发器，由 WebView 访问 `http://127.0.0.1:38417`，从而使录音与媒体权限可直接生效；电脑端按 `Host` / `Origin` 的同源校验与设备令牌鉴权保持不变。

当配对地址为 `https://`（例如配合 Tailscale 证书）时，WebView 直接连接目标地址，不开启本地转发。

### 2. 来源与设备令牌隔离（`Pairing.kt` / `MainActivity.kt`）
- `Server.parse` 仅接受 `http://` 与 `https://`，拒绝包含账号密码字段的地址。
- WebView 导航严格限制在当前已配对来源内，站外链接交由系统浏览器打开；拒绝存在 SSL 错误的页面加载。
- 网页请求录音或相机权限时，通过 `matchesWebOrigin()` 严格校验请求来源与当前 WebView 来源一致后才会授权。
- 切换电脑或调用 `changeServer` 时，会先关闭旧转发连接并清理 WebView Cookie 与 WebStorage，避免旧电脑的设备令牌被发往新来源。

### 3. 原生与网页桥接（`window.AuraNative`）
网页端检测到 `window.AuraNative` 时会自动启用原生能力：
- `serverOrigin()`：获取当前电脑的原始 `http(s)://host:port` 地址
- `changeServer(href)`：校验新服务器或二维码内容、清理旧存储并重新加载
- `scan()`：打开原生离线扫码页（基于 `zxing-android-embedded`，不依赖 Google 服务）并把结果回传给网页
- `notificationStatus()` / `requestNotifications()` / `notify(title, body, botId, id)`：按对话分组发送系统通知（Android 13+ 自动引导授予通知权限）

## 工程结构

```text
app/src/main/
├── AndroidManifest.xml
├── java/com/aureth/aurabot/mobile/
│   ├── MainActivity.kt    # 启动过渡、首次配对页、断连状态页、WebView 与 AuraNative 桥接
│   ├── ScanActivity.kt    # 自定义离线扫码界面（手电筒、手动粘贴入口）
│   ├── SilkViews.kt       # 深浅色质感卡片/按钮、按压反馈与细线加载条等 UI 组件
│   ├── Forwarder.kt       # 127.0.0.1:38417 本机回环 TCP 原样转发器
│   └── Pairing.kt         # Server / Pairing 地址与二维码载荷解析与同源判断
└── res/
    ├── values/            # 浅色配色与图标底色定义
    ├── values-night/      # 深色配色定义
    ├── drawable*/         # 自适应/单色启动图标、通知图标与界面矢量图标
    └── xml/               # 网络安全配置（允许局域网/回环明文流量）
```

## 权限说明

- `INTERNET`：连接电脑端 Aurabot 服务或本地回环转发端口
- `RECORD_AUDIO`：在聊天界面按住发送语音消息
- `CAMERA`：扫描电脑面板生成的配对二维码
- `POST_NOTIFICATIONS`：在后台收到回复时显示系统通知（Android 13+）

## 本地构建

环境要求：JDK 17+（编译字节码目标为 Java 17）、Android SDK（`compileSdk 34` / `build-tools 34`）、Gradle 8.7（工程采用 AGP `8.5.2`、Kotlin `2.0.20`）。

在工程根目录执行：

```powershell
$env:JAVA_HOME = 'C:\Program Files\Eclipse Adoptium\jdk-21.0.8.9-hotspot'
$env:ANDROID_HOME = 'D:\Android\Sdk'
gradle --no-daemon --console=plain assembleDebug
```

构建完成后，调试安装包位于：
`app/build/outputs/apk/debug/app-debug.apk`
