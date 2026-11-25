# 云端画面（TUTK）是怎么来的

一句话：云端画面不是 Node 自己连上去画的。Node 只负责向 Bambu 云端要一张「临时门票」，然后把门票交给一个很小的本机 C 程序；真正和打印机打交道的，是这个程序运行时加载的 **BambuSource** 库。

这份文件先讲你能看到的过程，再讲端口、凭据和失败原因。你不需要懂 TUTK 协议也能读完。

## 先讲人话：点一次「拍照」会发生什么

1. 你在私聊发「/打印机 拍照」，或由外部调用 `/photo`。
2. 如果这台打印机有局域网 IP 和访问码，先走局域网：A1 / A1 mini / P1P / P1S 抓 `:6000` 的 MJPEG；X1 / H2 / P2S / X2D 抓 `:322` 的 RTSPS（需要本机 `ffmpeg`）。
3. 局域网走不通、或这台只有云端绑定，才走云端画面：用**这台打印机所属用户**的云端 token，向 Bambu 云端换一个一次性的 TUTK 凭据（`ttcode`）。
4. Node 把凭据拼成 `bambu:///tutk?uid=…&authkey=…&passwd=…&region=…`，写进一个权限 **0600** 的临时文件。
5. Node 启动模块自带的抓帧桥，参数里只有临时文件路径，**没有 URL、没有密码**：

   ```text
   bambu-tutk-bridge --url-file <临时目录>/url.txt --dump <临时目录>/samples.bin --seconds 20
   ```
6. 桥在运行时加载 BambuSource 库，按顺序调 `Bambu_Create → Bambu_Open → Bambu_StartStream → Bambu_ReadSample`，把拿到的样本写进 `samples.bin`。
7. 样本如果是 MJPEG，直接用；如果是 H.264 Annex-B，交给本机 `ffmpeg` 解一帧 JPEG。
8. 不管成功失败，临时目录（URL 文件 + 样本）递归删掉；Node 只把 JPEG 返回给发起拍照的人。

**顺序很重要**：局域网优先，云端 TUTK 只是回退。纯局域网绑定（`mode !== "cloud"`）失败时**不会**偷偷走云端，会直接说「局域网拍不了」。

## 为什么不能纯 Node 实现

不是「懒得写」，是协议层次和 Node 自带能力对不上：

- Node 的 `tls` 只做 TLS 1.2/1.3 主模式，**不支持 DTLS**；TUTK 用的是 DTLS 1.2 PSK。
- DTLS-PSK 的套件、epoch/序号 AAD、CBC 的 Encrypt-then-MAC 都要自己拼。
- AV 层还要做 FEC 重组和 H.264 分片合并。
- 外面还有 IOTC 的 TransCodePartial 混淆、打洞/中继、master JOIN。

这些活 OBN（`ClusterM/open-bamboo-networking`）已经用原生代码做好，并编进了 `BambuSource.dll / libBambuSource.so`。本模块不把 OBN 的代码编进自己的产物；它自带一个 MIT 的单文件 C 桥，运行时用 `LoadLibrary` / `dlopen` 加载你自己安装的那份库，调它的 C ABI。

## 链路和端口（细节）

下面这段协议层次来自 OBN 的研究文档（`research/06.07-tutk.md`）。**本模块没有自己实现这些协议**，只是调用 BambuSource；这些数字用于理解「为什么需要桥」，不是本模块代码里的常量。

```text
UDP（32761 局域网广播 / :3478 rendezvous / 中继）
  └─ IOTC 数据报（TransCodePartial 混淆，16 字节头）
       └─ DTLS 1.2 PSK（12 字节子头）
            └─ AV 包（8 字节头）：login、stream、IOCtrl、心跳
                 ├─ 视频帧（H.264，FEC 分组，1024 字节切片）
                 └─ IOCtrl 0x3001 JSON RPC（文件浏览器 / ft_*）
```

本模块会碰到的端口，按用途分开看：

| 端口 / 地址 | 谁用 | 说明 |
|---|---|---|
| `8883` | 打印机 MQTT over TLS | 看状态、发控制命令；不是 TUTK |
| `6000` | 局域网摄像头 MJPEG | A1 / A1 mini / P1P / P1S |
| `322` | 局域网摄像头 RTSPS | X1 / H2 / P2S / X2D，需要 ffmpeg |
| `3478` | TUTK rendezvous / 中继 | ThroughTek 公网，打洞失败时走这里 |
| `32761` | TUTK 局域网广播 | OBN 研究文档里的发现端口；本模块代码没有直接用它 |
| `2021` | 拓竹打印机 SSDP 发现 | 面板「搜索局域网打印机」用；不是 TUTK |

**TUTK 不是纯局域网。** IOTC 打洞失败时会走 ThroughTek 的公网 rendezvous / 中继（`:3478`）。画面数据到底走局域网还是公网，由 BambuSource 自己决定，模块只把 ttcode 交给它。

## 桥怎么拿到凭据

### 1. 先向 Bambu 云端铸 ttcode

代码在 `lib/tutk.mjs`：

- 请求：`POST {region.api}/v1/iot-service/api/user/ttcode`；
- 区域：`us/eu` 用 `https://api.bambulab.com`，`cn` 用 `https://api.bambulab.cn`；
- 头：`Authorization: Bearer <access token>`，加一组模仿 BambuStudio 切片器的 `X-BBL-*` 头（`X-BBL-Client-Version` / `X-BBL-Agent-Version` 都是 `02.09.01.55`）；
- 体：`{ dev_id: 序列号, dev_version: 型号, protocols: ["tutk"] }`；
- 超时：调用方传 `12000` 毫秒；函数内部夹在 `3000~60000` 毫秒，默认 `12000`；
- 成功解析 `uid / authkey / passwd`，拼成 `bambu:///tutk?…`。

错误文本只报固定话术和 HTTP 状态码，不回声 token；网络异常里的 token 片段会被替换成 `••••`。

**注意**：`mintTutcode()` 的返回值里其实带 `uid / authkey / passwd / url` 四个字段（老文档说「只有 URL」是不对的）。调用方只把 `url` 交给桥；这些值不会写日志、不会进错误文本，也不会进 argv。

### 2. 凭据只进 0600 临时文件

代码在 `lib/tutk-bridge.mjs` 的 `captureViaBridge()`：

- 用 `mkdtemp(path.join(tmpdir(), "bambu-tutk-b-"))` 建临时目录；
- 把 URL 写进 `url.txt`，模式 `0600`，写完再 `chmod(0o600)` 一次；
- 起桥的参数固定是：

  ```text
  --url-file <dir>/url.txt --dump <dir>/samples.bin --seconds N [--lib <BambuSource 路径>]
  ```

- **URL 从不进 argv**。同机其它进程看 `ps` / 进程列表，只能看到临时文件路径、`--seconds`、`--lib` 这类参数。
- 桥的 stderr 会被收集并擦掉 URL 里的参数值（每个 `?key=value` 的 value 都会替换成 `••••`）；最多留 4000 字。
- BambuSource 自己的日志默认关掉（桥会设 `BAMBUSOURCE_LOG_LEVEL=off`、`OBN_BAMBUSOURCE_LOG_LEVEL=off` 等），因为库可能打印完整 URL。只有加 `--verbose` 才会打开，排查时别把输出贴到公开地方。
- 结束时 `rm(dir, { recursive: true, force: true })`，URL 文件和样本一起删。

### 3. 抓帧、解码、超时

- 桥先做哈希校验：模块自带的桥必须和 `SHA256SUMS` 对上，对不上直接拒绝执行（`BRIDGE_HASH_MISMATCH`），一个字节都不跑。清单缺失时跳过校验（老版本兼容）。
- 桥加载 BambuSource，调用 C ABI，把样本写到 `--dump` 文件。
- Node 读样本时卡 **16MB** 上限（`BRIDGE_MAX_BYTES`）；桥自己写文件时卡 **64MB**。
- 样本是 JPEG（MJPEG）就直接用；否则按 H.264 Annex-B 交给 `ffmpeg`：

```text
ffmpeg -hide_banner -loglevel error -y -f h264 -i samples.bin -frames:v 1 -f image2 -vcodec mjpeg frame.jpg
```

ffmpeg 这一步自己的超时是 `30000` 毫秒。

- `--seconds` 的来源：设置 `tutkTimeoutMs`（`3000~60000` 毫秒，默认 `20000`）÷ 1000，取整后至少 2 秒；桥端再夹到 `2~60` 秒。默认 20 秒。
- 桥进程总超时是 `tutkTimeoutMs + 20000` 毫秒（默认 40 秒；最大 80 秒）。`captureViaBridge()` 内部还会再夹到 `5000~120000` 毫秒。
- 桥连接打印机时自己另有 **20 秒** 的 `Bambu_Open` 预算和 **20 秒** 的 `StartStream` 预算；这两个数字在 C 源码里写死，不受 `tutkTimeoutMs` 控制。

### 4. 老桥/自定义桥的回退

模块自带的桥用新参数（`--url-file / --dump / --seconds`）。如果设置里换了自定义桥，调用器会先试新参数；出现下面情况时自动改试旧协议：

- 退出码是 `1 / 2 / 64 / 70 / 78`，或 stderr 里出现 `usage` / `unknown option` 之类；
- 新协议退出 0，但根本没写 `--dump` 文件。

旧协议是：不带参数启动，stdin 写一行 JSON：

```json
{"url":"bambu:///tutk?…","serial":"…","format":"jpeg"}
```

stdout 输出一张 JPEG。旧协议下 URL 仍然不进 argv，但 stdout 大小上限（16MB）和错误脱敏由旧桥自己负责；模块只做退出码归类和上限。

## BambuSource 从哪来

本模块**不打包** BambuSource（OBN 是 AGPL-3.0）。它来自 OBN 的 Releases：

<https://github.com/ClusterM/open-bamboo-networking/releases>

| 平台 | 下载哪个包 | 取包里的哪个文件 |
|---|---|---|
| Windows x64 | `obn-windows-x64.zip` | `lib/v02.09.01/BambuSource.dll` |
| Linux x64 | `obn-linux-x64.tar.gz` | `lib/libBambuSource.so` |

### 最省事：面板按钮

面板「设置 → 下载 BambuSource 库」会：

1. 查 OBN 最新 Release（查不到就用已知版本 `v2.3.0`）；
2. 下载对应压缩包；
3. 只解出那一个库文件，别的不落地；
4. 默认放到 `modules-data/bambu-print/bambusource/`。

**为什么不是桥同目录？** 模块目录一有文件变化，插件可能会热重载，内存里的解锁会话会被清空。所以自动下载默认落到数据目录；下载成功后，如果设置 `tutkLibPath` 还是空的，模块会把实际路径写回设置，抓帧时按这个路径找。

当前 `KNOWN_LIB_SHA256["v2.3.0"]` 里两个哈希都还是空串，所以下载结果会带 `verified: false`，表示「这份没有校验和」。表里没有的版本也不会拦死，同样标 `verified: false`；只有表里填了哈希的版本才会硬校验，对不上就 `LIB_SHA256_MISMATCH`。

### 手动放

三种位置，按优先级：

1. 面板「设置 → BambuSource 库路径」填**库文件路径**（不是目录）；
2. 环境变量 `BAMBU_SOURCE_LIB`；
3. 桥程序同目录，文件名必须是 `BambuSource.dll` / `libBambuSource.so`。

面板自检和 C 桥对「显式指定」的语义一致：**填了就必须存在，找不到直接算缺库，不会偷偷换下一个位置**。

C 桥自己还会去 Bambu Studio / OrcaSlicer 的插件目录找最高版本（Windows 的 `%APPDATA%\BambuStudio\plugins\v*\`、Linux 的 `~/.config/BambuStudio/plugins/v*/` 等）。但模块拍照时会把自检结果作为 `--lib` 显式传给桥；桥对显式 `--lib` 是硬选，不会回退。所以实际用模块拍照时，请确保上面三种位置之一有库，别指望插件目录兜底。

### 国内下载走哪些代理

下载资源走 GitHub Releases。国内网络先走下面四个加速代理，全失败再回退直连；国外先直连，失败才用代理：

1. `https://githubproxy.cc/`
2. `https://ghfast.top/`
3. `https://ghproxy.net/`
4. `https://gh-proxy.com/`

Release 信息本身走 `https://api.github.com/repos/ClusterM/open-bamboo-networking/releases/latest`，通常不经过代理；拿不到就退回已知版本 `v2.3.0`。

下载尽量用 HTTP Range：Windows 包会先读尾部/中央目录，只拉目标 DLL 的那一段；Linux 的 tar.gz 目前会把整个包读下来（服务器支持 Range 时一次读全量，不支持时流式写到临时文件），再 gunzip + 扫 tar 头。大小上限是 **320MB**（整包、Range 声明总量、单次读取、ZIP 条目声明的解压后大小、解压输出都卡这个上限），超过就 `TOO_LARGE`，不会先分配一大块内存。

下载超时：面板路由默认 **8 分钟**，可传 `timeoutMs`，夹在 **60 秒~10 分钟**。文件小于 64KB 视为没下完整，直接报错，不写半个文件。

### 平台和 ffmpeg

- 自动下载和自带桥只支持 **Windows x64**、**Linux x64**。macOS（darwin）、linux arm64、win32 arm64 等没有预编译产物：`defaultBridgePath()` 返回空串，下载路由直接 `UNSUPPORTED_PLATFORM`，面板会说「没有预编译桥，请自己编」。
- H.264 机型（X1 / H2 / P2S / X2D）需要本机 `ffmpeg` 在 `PATH` 里；A1 / A1 mini / P1P / P1S 是 MJPEG，不需要 ffmpeg。
- 云端 TUTK 抓到 H.264 时同样需要 ffmpeg 解一帧；没有就 `NO_FFMPEG` / `FFMPEG_FAILED`。

## 失败时你看到什么

`/photo` 失败时返回 `{ ok:false, code, message }`。下面是常见 code 和用户会看到的话。局域网失败的前缀是「局域网拍不了：…」，云端抓帧失败的前缀是「云画面抓帧失败：…」。

`RTSPS_*` 是 `captureRtspsSnapshot()` 抛出的底层 code：`/photo` 在纯局域网失败时会把它包进 `NO_LAN` 的 message，在云端绑定时会改走 TUTK。所以调 `/photo` 不一定直接看到这些 code，但排查时会在 message/日志里看到它们。

| code | 用户看到什么 | 原因 |
|---|---|---|
| `NO_LAN` | 「局域网拍不了：…」 | 纯局域网绑定，没有 IP/访问码或局域网这条路失败；不会回退云端 |
| `CAMERA_UNPINNED` | 「摄像头证书没固定，为了不把访问码交给不认识的对端，这次不抓拍：…」 | `:6000` 没有锚点 |
| `RTSPS_UNPINNED` / `RTSPS_CERT_UNPINNED` | 「RTSPS 证书没固定，为安全起见不会启动 ffmpeg…」 | `:322` 没有 pin；ffmpeg 一次都没启动 |
| `RTSPS_CERT_MISMATCH` | 「RTSPS 对端证书与已固定的不一致…」 | `:322` 证书换了，拒绝发访问码 |
| `NO_TUTK_TOOL` | 「云端画面要走 TUTK：模块自带抓帧桥，请在设置里指定它的路径。」 | 桥路径为空或平台没有自带桥 |
| `NO_TOKEN` / `LOCKED` | 「这台打印机没有云端 token…」/「云端画面需要这台打印机的 token，但绑定者现在没解锁…」 | 绑定里没有 token，或取 token 时绑定者的会话锁着（让他发一条打印机命令就会自动恢复） |
| 铸码错误 | 「云画面铸码失败：…」 | token 无效/没权限/超时/云端没返回 uid 等 |
| `NO_BAMBUSOURCE` | 「没有找到 BambuSource 库（云端画面要用它）…放到抓帧桥同目录…」 | 库没放好，或显式路径不存在 |
| `TIMEOUT` | 「TUTK 抓帧失败：…」 | 桥/进程超时 |
| `EMPTY_DUMP` | 「桥没有输出样本（云画面没开、ttcode 过期，或 BambuSource 版本不匹配）」 | 桥跑了但没拿到画面 |
| `FFMPEG_FAILED` / `NO_FFMPEG` | 「H.264 转 JPEG 失败（X1/H2/P2S 的 H.264 需要本机 ffmpeg）…」 | 没装 ffmpeg 或 ffmpeg 失败 |
| `BRIDGE_HASH_MISMATCH` | 「抓帧桥和模块自带的不一致…」 | 预编译桥被改过/损坏 |
| `BRIDGE_FAILED` | 「TUTK 抓帧失败（检查桥路径与执行权限）…」 | 桥起不来/退出码异常 |

## 边界和代价

- 只抓**一帧**，不是实时视频；没有声音，也不持续录像。
- ttcode 的服务窗口，代码注释写的是大约 **9 分钟**（本模块不控制这个窗口）；每次走云端拍照都重新铸码，不复用缓存（代码里还留着 `TUTK_MAX_CACHE_MINUTES = 8` 常量，但当前没有缓存逻辑）。
- 云端账号没绑打印机、打印机离线、账号没有云画面权限，都会在铸码或 StartStream 阶段失败；不会返回旧图。
- 局域网首次仍是 TOFU：第一次连接会信任当时看到的证书；要彻底排除中间人，只能带外核对指纹。MQTT `:8883`、MJPEG `:6000`、RTSPS `:322` 三套证书分开固定，不能互相顶替。
- 桥是预编译二进制。模块自带的那份有 `SHA256SUMS` 校验；但清单缺失时会跳过（老版本兼容），自定义桥也不在清单里。这是供应链上的现实边界，不是「零信任」。
- 模块只带 Windows x64 / Linux x64 两个产物；其它平台要自己编，见 `../assets/tutk-bridge/README.md`。
