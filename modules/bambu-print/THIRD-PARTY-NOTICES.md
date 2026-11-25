# 第三方代码与许可

本模块整体是 MIT（见 [LICENSE](LICENSE)）。下面是被引用、但不随包分发的东西，以及随包分发的第三方产物来源。

## 随包分发的

| 文件 | 许可 | 说明 |
|---|---|---|
| `assets/tutk-bridge/bambu-tutk-bridge.c` | MIT（本仓库） | 单文件 C 抓帧桥，本模块自己写的 |
| `assets/tutk-bridge/bambu-tutk-bridge.exe` | MIT（由上面的 .c 编译） | Windows x64 产物 |
| `assets/tutk-bridge/bambu-tutk-bridge-linux-x64` | MIT（由上面的 .c 编译） | Linux x64 产物 |

两个二进制都由同目录的 `bambu-tutk-bridge.c` 用 zig 0.17.1（clang 22.1.8 / LLD 22.1.8）编译。
`assets/tutk-bridge/SHA256SUMS` 记着三个文件的哈希，模块在启动桥之前会核对，对不上就不执行。
Linux 那份可以逐字节复现（`assets/tutk-bridge/build.sh --repro`）。

桥本身不含任何第三方代码：Windows 端只依赖 `kernel32` + UCRT，Linux 端只依赖 `libc` + `libdl`。

## 运行时加载、但不随包分发的

| 组件 | 许可 | 怎么来的 |
|---|---|---|
| `BambuSource.dll` / `libBambuSource.so`（[open-bamboo-networking](https://github.com/ClusterM/open-bamboo-networking) 的产物） | **AGPL-3.0** | 用户自己从 OBN 的 Releases 取；面板里有个按钮可以代下（只取压缩包里那一个库文件，落到数据目录，不写进模块目录）。模块**不打包、不复制、不重新分发**它 |

抓帧桥在运行时用 `LoadLibrary` / `dlopen` 动态链接用户本机这一份。这是动态链接，不是把 AGPL 代码并进本模块。

**哈希钉版**：`lib/tutk-lib.mjs` 的 `KNOWN_LIB_SHA256` 按「版本 + 资产 + 库名」记 sha256，
下载后先核对再落盘，对不上直接丢弃。表里还没填哈希的版本会照常下载，但结果标为未校验，
面板会如实提示。想用别的版本就手动下载，把路径填进「BambuSource 库路径」。

## 参考实现（只读参考，未复制代码）

- [open-bamboo-networking](https://github.com/ClusterM/open-bamboo-networking)（AGPL-3.0）——
  协议行为参考（MQTT 主题、TUTK 调用顺序）。
- [OpenBambuAPI](https://github.com/Doridian/OpenBambuAPI) —— 打印状态字段说明。

本模块的 MQTT / 相机 / 状态归一化代码是自己写的，没有从这两个项目复制源码。

## 商标

Bambu Lab、Bambu Studio 是各自所有者的商标。本模块与 Bambu Lab 无隶属关系，也不代表其认可。
