# 内置 TUTK 抓帧桥（bambu-tutk-bridge）

## 先说结论：你不用自己编

仓库里已经带了两个能直接用的成品：

| 平台 | 文件 | 大小 | 编译方式 |
|---|---|---|---|
| Windows x64 | `bambu-tutk-bridge.exe` | 226816 字节 | `zig cc -O2` |
| Linux x64 | `bambu-tutk-bridge-linux-x64` | 12936 字节 | `zig cc -O2 -s -target x86_64-linux-gnu … -ldl` |

模块会按平台自动找这两个文件名。**大多数用户不需要装编译器，也不需要看懂 C。** 只有下面几种情况才需要自己编：

- 你用的不是 Windows x64 / Linux x64（比如 macOS、Linux arm64、Windows arm64）；
- 你想换一个自己改过的桥；
- 你想自己复现/核对仓库里的二进制。

## 它是干什么的

一句话：Node 不会直接加载 BambuSource 这个原生库，所以中间放一个很小的 C 程序做「二传手」。

一次抓帧的流程：

```text
Node（模块）
  → 把 bambu:///tutk?… 写进 0600 临时文件
  → 启动 bambu-tutk-bridge --url-file … --dump … --seconds N
桥
  → 加载 BambuSource.dll / libBambuSource.so
  → Bambu_Create → Open → StartStream → ReadSample
  → 把样本写进 --dump 文件
Node
  → MJPEG 直接用；H.264 交给 ffmpeg 解一帧
  → 删临时目录
```

为什么不直接在 Node 里做？因为 TUTK 用到 DTLS-PSK、IOTC、AV/FEC、H.264 重组，Node 自带的 `tls` 不支持 DTLS；这些活 OBN 已经用原生代码做好，编进了 BambuSource。桥只负责调它的 C ABI，不复制 OBN 的代码。

## 它依赖什么

| 依赖 | 什么时候需要 | 说明 |
|---|---|---|
| Windows 系统 API（`kernel32`） | Windows 运行 | 只用 `LoadLibrary` / `GetProcAddress` / 文件 API |
| `libdl` + libc | Linux 运行 | 用 `dlopen` / `dlsym` 加载库 |
| BambuSource 库 | 抓帧时 | `BambuSource.dll` 或 `libBambuSource.so`，本模块**不打包**（OBN 是 AGPL-3.0） |
| `ffmpeg` | 只有 H.264 样本 | X1 / H2 / P2S / X2D；A1 / P1P 等 MJPEG 机型不需要 |
| C 编译器 | 只有自己编时 | C99 或更新的 `cc` / `gcc` / `clang` / `cl` / `zig` |

不需要 .NET、Node、npm、Python，也不需要任何第三方运行库。

## BambuSource 放哪

### 最省事：面板按钮

面板「设置 → 下载 BambuSource 库」会自动查 OBN Releases、下载压缩包、只解出那一个库文件，默认放到：

```text
modules-data/bambu-print/bambusource/
```

下载成功后，如果设置里的「BambuSource 库路径」还是空的，模块会把实际路径写进设置，抓帧时按它找。

### 手动放：三个位置

按优先级：

1. 面板「设置 → BambuSource 库路径」填**库文件路径**（不是目录）；
2. 环境变量 `BAMBU_SOURCE_LIB`；
3. 桥程序同目录，文件名必须是 `BambuSource.dll` / `libBambuSource.so`。

桥对「显式指定」是硬选：`--lib` 或设置里填了路径，但文件不存在，就直接失败，不会偷偷换下一个位置。模块的 `/tutk/status` 预检也是同一套语义。

C 桥自己还会去 Bambu Studio / OrcaSlicer 的插件目录找最高版本（Windows 的 `%APPDATA%\BambuStudio\plugins\v*\`、Linux 的 `~/.config/BambuStudio/plugins/v*/` 等）。但模块拍照时会把预检结果作为 `--lib` 显式传给桥，而桥对 `--lib` 不回退；所以实际用模块时，请确保上面三个位置之一有库。

### 下载来源

```text
https://github.com/ClusterM/open-bamboo-networking/releases
```

| 平台 | 下载哪个包 | 取包里的哪个文件 |
|---|---|---|
| Windows x64 | `obn-windows-x64.zip` | `lib/v02.09.01/BambuSource.dll` |
| Linux x64 | `obn-linux-x64.tar.gz` | `lib/libBambuSource.so` |

国内网络会按 `githubproxy.cc` → `ghfast.top` → `ghproxy.net` → `gh-proxy.com` 的顺序尝试加速代理，全失败再回退直连；国外先直连。Windows 包会走 HTTP Range，只拉目标 DLL 那一段；Linux 的 tar.gz 目前会整包读下来再解压。大小上限 320MB。

## 怎么编译

### Linux

```sh
# 复现仓库里那份 Linux 产物（需要同版本 zig 0.17.1）
ZIG=/path/to/zig ./build.sh --repro

# 用系统自带的 cc / gcc / clang 编一个普通产物
CC=gcc ./build.sh

# 换输出文件名
OUT=my-bridge ./build.sh
```

`build.sh --repro` 实际执行的是：

```sh
zig cc -O2 -s -target x86_64-linux-gnu -o bambu-tutk-bridge-linux-x64 bambu-tutk-bridge.c -ldl
```

`-s` 会去掉调试信息；不加它，构建机的绝对路径会被写进 `.debug_str`。普通 `cc` 编译时，脚本先带 `-ldl`，失败再退回不带 `-ldl`（musl / macOS 没有独立 libdl）。

### Windows

在 `cmd` 里：

```bat
set ZIG=C:\path\to\zig.exe
build.bat
```

`build.bat` 会按顺序找：

1. 环境变量 `ZIG`；
2. `PATH` 里的 `zig`；
3. MSVC 的 `cl`（要在「x64 Native Tools Command Prompt」里跑）；
4. MinGW 的 `gcc`。

用哪个都会打印出来。等价的手工命令：

```bat
zig cc -O2 -o bambu-tutk-bridge.exe bambu-tutk-bridge.c
cl /nologo /O2 bambu-tutk-bridge.c /Fe:bambu-tutk-bridge.exe
gcc -O2 -o bambu-tutk-bridge.exe bambu-tutk-bridge.c
```

### 编完放哪

- 想让模块默认用它：把产物命名成上表的 `bambu-tutk-bridge.exe` / `bambu-tutk-bridge-linux-x64`，放回 `assets/tutk-bridge/`；
- 想留着别的桥：在面板「设置 → 抓帧桥路径」填它的绝对路径；留空才用模块自带的。

Linux 上从 zip 解出来的文件可能没有执行位；模块在启动桥之前会补一次 `chmod 0755`（只加执行位，不改别的权限）。如果目录只读、加不上，模块会按原样报「检查桥路径与执行权限」。

## 怎么核对仓库里的成品

`SHA256SUMS` 里记着两个产物和 C 源码的 sha256：

```text
5b1c2129f828b0f2eadbb64fdd472fe84ad5d3897140b0e1f8bc7a6ffb19295a  bambu-tutk-bridge.exe
95fd9e78255098c1685be728596a8d11891058be84d8c2666ec511b8f412ea56  bambu-tutk-bridge-linux-x64
88698846cddc93df11641e5d243e755ed7a3e86853ae9dfd9ffada7079313947  bambu-tutk-bridge.c
```

模块在启动**自带桥**之前会核对一次对应产物的哈希；对不上就拒绝执行，返回 `BRIDGE_HASH_MISMATCH`。清单缺失/清单里没有这个名字时会跳过（老版本/自定义桥兼容）。

两个产物都由同目录的 `bambu-tutk-bridge.c`（单文件、MIT、约 18KB）编译而来，编译器是 zig 0.17.1（clang 22.1.8 / LLD 22.1.8）。

- Linux 那份可以逐字节复现：`./build.sh --repro`。
- Windows 那份代码段可复现，但整文件会差约 20 字节（PE 时间戳 + PDB 签名，LLD 每次生成不同；连编两次也会差这么多）。比 `.text / .rdata / .data` 一致即可认为同源。

## 自检

```sh
# 打印它找到的 BambuSource 路径；找不到会列出已尝试的路径
bambu-tutk-bridge --print-lib

# 验证库能加载、导出函数齐全
bambu-tutk-bridge --selftest
```

面板「设置 → 检查 TUTK 组件」走的是同一套检查：只读文件，不连打印机。

## 调用约定

```text
bambu-tutk-bridge --url-file <tmp> --dump <tmp.bin> [--seconds N] [--lib <BambuSource>] [--verbose]
bambu-tutk-bridge --print-lib
bambu-tutk-bridge --selftest
```

- `--url-file`：第一行是 `bambu:///tutk?uid=…&authkey=…&passwd=…&region=…`；
- `--dump`：输出原始样本（MJPEG 帧，或 H.264 Annex-B 拼接）；
- `--seconds`：采集时长，`2~60` 秒；默认 `8` 秒；`lib/tutk-bridge.mjs` 实际会按设置传，默认 20 秒；
- `--lib`：显式指定 BambuSource；给了但文件不存在就直接失败；
- `--verbose`：打开 BambuSource 自己的日志。**库可能打印完整 URL（含密码）**，只在排查时用，别把输出贴到公开地方。

退出码：

| 退出码 | 含义 |
|---|---|
| 0 | 成功，样本已写入 `--dump` |
| 2 | 参数错 / URL 文件读不到 / 不是 `bambu:///` 开头 |
| 3 | 找不到或加载不了 BambuSource，或缺导出函数 |
| 4 | `Bambu_Create` 失败 |
| 5 | `Bambu_Open` 失败 |
| 6 | `Bambu_StartStream` 失败（打印机没开云画面 / ttcode 过期 / 账号没权限） |
| 7 | 写不了 `--dump` 文件 |
| 8 | 连上了但没拿到样本 |

模块会把退出码 3 翻成一句人话：「没有找到 BambuSource 库……下载 OBN Releases……放到桥同目录」。

## 安全边界

- **凭据不进 argv。** 新协议下 URL 只在 `--url-file` 指向的临时文件里；模块用 `0600` 建这个文件，写完再 `chmod`。旧协议（自定义桥）把 URL 写进 stdin，仍然不进 argv。
- **库日志默认关闭。** 桥会设 `BAMBUSOURCE_LOG_LEVEL=off`、`BAMBUSOURCE_LOG_STDERR=0` 以及 `OBN_*` 对应变量；只有 `--verbose` 才打开。
- **桥自己不联网。** 源码里没有 socket / HTTP 调用；真正的 TUTK 流量发生在它加载的 BambuSource 里。
- **桥不执行外部命令。** 源码里没有 `system` / `popen` / `exec*` / `CreateProcess`；它只读 `--url-file`、写 `--dump`、找库。
- **临时目录会删。** Node 在 `finally` 里 `rm(dir, { recursive: true, force: true })`，URL 文件和样本不留。
- **限制**：桥是预编译二进制；自带那份有哈希清单，自定义桥没有。模块只能保证「自带桥和清单一致才跑」，不能替自定义桥背书。

## 许可

本桥 MIT。它运行时加载的 `libBambuSource` 属于 open-bamboo-networking（AGPL-3.0）；本模块不打包该库，也不复制其代码，只调用你自己安装的副本。
