# bambu-print 安全复查记录（2026-11-13）

> **这是一份历史记录，不代表现在的代码还有这些缺陷。** 它写的是 2026-11-13 那次复查发现了什么、后来怎么修、现在由哪条测试盯着。看当前行为请读 [README.md](../README.md) 和 [ROUTES.md](ROUTES.md)。

复查范围：前一次审查记录里的安全/功能问题，以及修复后的回归。
方法：静态复核、Node 全量测试、定向测试、模块装配模拟。**没有连接真实打印机、Bambu 云服务，也没有做主动网络中间人测试。**

## 结论

- 当时列出的 P1 / P2、功能、文档问题都已修复，并补了回归测试。
- 复查当天记录全量 **422 项通过，0 失败**。
- 2026-11-14 重写这份文件时又跑了一次：**471 项通过，0 失败**（36 个 suite，约 13 秒；命令是 `node --test "test/*.test.mjs"`）。其中一条是新加的回归：非主人会话锁定后，命令和模型工具都会自动恢复。
- 「测试全绿」只说明代码路径和回归用例通过，不等于真机验证；下面「验证限制」会写清楚没测什么。

---

## P1（已修复）：RTSPS（:322）抓拍没有核对对端证书

### 当时是什么问题

RTSPS 的访问码已经改成走 ffmpeg stdin，不再进 argv。但 `:322` 这条链路仍然没有校验对端证书，也没有应用 CA/指纹 pin。`:6000` 学到的锚点不能拿到 `:322` 用——两个端口是两套证书。

后果：同一局域网里能做主动中间人的人，可能让 X1/H2/P2S/X2D 把访问码发给冒充端，或返回伪造画面。

### 怎么修的

`captureRtspsSnapshot()` 在 spawn ffmpeg **之前**先自己跟 `:322` 握手取证书，再用 `verifyRtspsPeerCert()` / `verifyPinnedCert()` 和 pin 比对：

- 没有 pin（默认 `requirePin: true`）→ `RTSPS_UNPINNED`；
- 握手失败 / 拿不到证书 → `RTSPS_CERT_UNVERIFIED`；
- 指纹不一致 → `RTSPS_CERT_MISMATCH`。

这三种情况**ffmpeg 一次都不会启动**，访问码连 stdin 都没进过。`:6000` 的 `ca` 故意不参与 `:322` 的比对；`:322` 用 `rtspsCa` / `expectedFingerprint` 这套单独的参数。第一次成功抓到后，上层把实测指纹落盘，下次开始严格比对。

位置：[camera.mjs](../lib/camera.mjs#L349)（`verifyRtspsPeerCert`）、[camera.mjs](../lib/camera.mjs#L596)（`captureRtspsSnapshot`）、[index.mjs](../index.mjs#L959)（拍照时把 `expectedFingerprint` / `rtspsCa` 传进去）。

### 现在什么状态

已修复。`:322` 的证书核对发生在启动 ffmpeg 之前；没 pin、pin 不对、握手失败都 fail-closed。

### 哪条测试盯着

[camera.test.mjs](../test/camera.test.mjs#L611) 的 `RTSPS TLS：spawn 前必须核对 :322 对端证书` 一组：

- `指纹不匹配 → RTSPS_CERT_MISMATCH，且 ffmpeg 一次都没启动`
- `未 pin 且未显式放行 → RTSPS_UNPINNED，ffmpeg 0 次，但带回实测指纹供固定`
- `握手失败（连接失败 / 超时 / 无证书）→ 拒绝且 ffmpeg 0 次`
- `:6000 的 ca 锚点不会被当成 :322 的 pin（两端口证书不同）`
- 另有 [camera.test.mjs](../test/camera.test.mjs#L322) 的 `P2-2：RTSPS 凭据不进 argv` 盯着「argv 干净、访问码只走 stdin」。

---

## P2（已修复）：TUTK Range 响应体可能在检查前被完整缓冲

### 当时是什么问题

Range 请求的长度在发请求前有限额，但 `RemoteFile.read()` 对 HTTP 206 仍然直接 `arrayBuffer()`，实际 body 字节数没有在读取过程中限制。服务端只要声称总大小在上限内，却对一次很小的 Range 请求回一个超长 body，这些字节会先整块进内存，然后才被检查。

### 怎么修的

`RemoteFile.read()` 改走 `readBodyLimited()`：优先用 `body.getReader()` 流式读，累计超过本次请求长度或配置上限就立刻取消底层流并报错；没有流实现时才退回 `arrayBuffer()`，读完同样先卡上限。200（服务器忽略 Range）和 206 都走这套；content-range 的起点/终点/声明长度/总大小还会再核对一次，对不上算协议错误。

位置：[tutk-lib.mjs](../lib/tutk-lib.mjs#L254)（`readBodyLimited`）、[tutk-lib.mjs](../lib/tutk-lib.mjs#L401)（`RemoteFile.read`）。

### 现在什么状态

已修复。超长 body 在读取中途就会被取消，不会先吃满内存。

### 哪条测试盯着

[tutk-lib.test.mjs](../test/tutk-lib.test.mjs#L509) 的 `Range 206：body 比请求长度长得多 → TOO_LARGE 且读取中途取消（P2-1）`，以及 [tutk-lib.test.mjs](../test/tutk-lib.test.mjs#L538) 的正常路径、[tutk-lib.test.mjs](../test/tutk-lib.test.mjs#L568) 的「声明与实读不一致 → 协议错误」。

---

## P2（已修复）：自定义 BambuSource 文件名没有从下载路由传到下载器

### 当时是什么问题

下载器已经能把完整库文件路径拆成目录 + 自定义文件名，但 `/tutk/download` 只把 `resolved.dir` 传给下载器，没传 `resolved.fileName`。配置 `/tmp/libs/custom-source.so` 时，下载器会按标准名写成 `/tmp/libs/libBambuSource.so`，而运行时仍按自定义路径找库，这个配置就不工作。

### 怎么修的

`/tutk/download` 现在把 `resolved.fileName` 一起传给 `downloadBambuSource()`。配置 `/tmp/libs/custom-source.so` 就按这个名字落盘，运行时按同一路径找得到。

位置：[index.mjs](../index.mjs#L2257)（路由）、[index.mjs](../index.mjs#L2284)（传 `fileName`）、[tutk-lib.mjs](../lib/tutk-lib.mjs#L611)（下载器）。

### 现在什么状态

已修复。

### 哪条测试盯着

[index.test.mjs](../test/index.test.mjs#L846) 的 `面板 /tutk/download：注入下载成功 → 返回路径/版本/是否就绪，不泄露任何凭据`。里面专门断言了自定义库文件路径会被拆成父目录，且 `asked.fileName` 是用户填的 `custom-source.so`，不是标准名（约在该测试的 900~906 行）。

---

## 功能（已修复）：暂停等非 RUNNING 状态可能显示「已打印 20770 天」

### 当时是什么问题

`startOf()` 对非 `RUNNING` 状态返回 `0`，`fetchStatus()` 把它作为 `observedStart` 传给归一化逻辑；归一化只检查「是不是有限数」，于是 `0` 被当成 Unix epoch。复现输入：`PAUSE`、没有 `gcode_start_time`、进度 42%、剩余 30 分钟，格式化结果显示约「已打印 20770 天」。

### 怎么修的

- `startOf()` 对非 `RUNNING` 返回 `null`，并清掉这台打印机的观察记录；
- `normalizeStatus()` 只接受 `> 0` 且有限的 `observedStart`，其余一律当「没观测到」，退回按进度/剩余估算。

位置：[index.mjs](../index.mjs#L869)（`startOf`）、[status.mjs](../lib/status.mjs#L208)（`observedStart` 的判断）。

### 现在什么状态

已修复；暂停状态不会再出现纪元级时长。

### 哪条测试盯着

[index.test.mjs](../test/index.test.mjs#L1420) 的 `暂停中的打印机不显示纪元级已打印时长（startOf 返回 null 的回归）`；[status.test.mjs](../test/status.test.mjs#L116) 的 `observedStart 为 0 / 负数 / NaN 时当作没观测到，不能当 epoch`。

---

## 文档（已更新）：README 的局域网 TLS 描述

### 当时是什么问题

README 还写「默认接受自签名证书，可配置 tlsFingerprint」。当前 MQTT 路径在正式带凭据连接前要求 pin；没有锚点就 fail-closed，不会「先连上试试」。

### 怎么修的

README 按链路分开写：

- 云端 MQTT：系统 CA + 主机名校验；
- 局域网 MQTT（`:8883`）与 MJPEG（`:6000`）：TOFU 锚点 + 指纹固定，没有锚点就 fail-closed，不发访问码；
- RTSPS（`:322`）：启动 ffmpeg **之前**核对证书指纹，不一致不启动。

位置：[README.md](../README.md#L18)、[README.md](../README.md#L21)、[README.md](../README.md#L51)。

### 现在什么状态

这三段与当前实现一致。这份记录只核对 TLS 描述，不表示 README 的每个数字/页签数量都和代码一致。

---

## 前次问题复核（历史，已全部关闭）

这一节是上一轮报告里的问题。它们在当时已经修过；这次复查又对着代码和测试核了一遍。

### 已修复并有回归测试

- **模型工具绕过群白名单**：`api.tool` / `api.context` 现在先检查宿主群白名单，未获准群连打印机名字都不给。[index.mjs](../index.mjs#L1772)、[index.mjs](../index.mjs#L1834)；测试：[index.test.mjs](../test/index.test.mjs#L1311)、[index.test.mjs](../test/index.test.mjs#L1345)、[index.test.mjs](../test/index.test.mjs#L1367)。
- **云端 MQTT 未验证 broker**：云端只用系统 CA + Node 默认主机名校验；忽略 target 上误带的 CA/pin 降级字段。[printer.mjs](../lib/printer.mjs#L368)、[mqtt.mjs](../lib/mqtt.mjs#L256)；测试：[printer.test.mjs](../test/printer.test.mjs#L691)、[printer.test.mjs](../test/printer.test.mjs#L703)。
- **LAN MQTT 未 pin 时发送访问码**：状态/命令建连前先过 trust gate；没有锚点直接 `CERT_UNPINNED`，client 都不建。[printer.mjs](../lib/printer.mjs#L465)；测试：[printer.test.mjs](../test/printer.test.mjs#L648)、[printer.test.mjs](../test/printer.test.mjs#L659)。
- **MJPEG 无证书锚点仍抓拍**：没有锚点就不建连接、不发 80 字节认证包，直接 `CAMERA_UNPINNED`；纯 LAN 失败，云端绑定可回退 TUTK。锚点存在绑定者的 vault 里。[camera.mjs](../lib/camera.mjs#L441)、[camera.mjs](../lib/camera.mjs#L454)、[index.mjs](../index.mjs#L926)；测试：[index.test.mjs](../test/index.test.mjs#L717)、[camera.test.mjs](../test/camera.test.mjs#L224)。
- **模型工具可直接停止**：工具入口拒绝 `stop`，要求本人用聊天命令二次确认；不判权限、不下发、不写成功审计。[index.mjs](../index.mjs#L1817)；测试：[index.test.mjs](../test/index.test.mjs#L1384)。
- **RTSPS 访问码暴露在 argv**：改成 `concat` 描述脚本经 ffmpeg stdin 传入；argv 只有 `-f concat -i pipe:0` 这类固定参数。[camera.mjs](../lib/camera.mjs#L119)、[camera.mjs](../lib/camera.mjs#L649)；测试：[camera.test.mjs](../test/camera.test.mjs#L322)、[camera.test.mjs](../test/camera.test.mjs#L403)。
- **TUTK 集成测试没有实际走桥接**：补了纯云设备 TUTK 出图、LAN 证书失败回退 TUTK 的测试。[index.test.mjs](../test/index.test.mjs#L741)、[index.test.mjs](../test/index.test.mjs#L766)。
- **TUTK helper 功能边界**：库路径解析、旧桥协议、`BAMBU_SOURCE_LIB` 预检、平台+架构拒绝、尺寸上限、60 秒采集上限都有实现和测试。示例：[tutk-lib.test.mjs](../test/tutk-lib.test.mjs#L332)（`resolveDestDir`）、[tutk-bridge.test.mjs](../test/tutk-bridge.test.mjs#L127)（45/60 秒不被截到 30）、[tutk-bridge.test.mjs](../test/tutk-bridge.test.mjs#L145)（旧协议回退）、[tutk-bridge.test.mjs](../test/tutk-bridge.test.mjs#L231)（桥哈希）、[tutk-bridge.test.mjs](../test/tutk-bridge.test.mjs#L274)（只配 `BAMBU_SOURCE_LIB` 也算找到）。
- **ROUTES.md 的 photo/grant/TUTK 契约过期**：已按当前代码重写，见 [ROUTES.md](ROUTES.md)。这次重写时又修掉了「解密必须安全码」「/photo 单张 ≤1.6MB」「/control 支持 gcode」「/bind 会固定证书并试连」等过期说法。

**关于「路由层自定义文件名和实际 Range body 字节数仍未闭环」**：上一版记录里这两句是当时的状态；这次复查的两条 P2 已经把它们补上了，所以现在不再是未闭环项。

---

## 固有风险与验证限制

- **局域网首次 TOFU 仍然会信任第一次看到的证书。** 如果第一次连接本身就被主动中间人攻击，恶意证书可能被固定。这是 TOFU 的固有边界，不是上面任何一条缺陷。要彻底排除，只能带外核对指纹；私聊 `/打印机 证书` 能看到当前指纹（只给主人）。
- **没有用真实打印机/生产 MQTT broker/主动中间人验证。** 测试用的是假 client、假 socket、假 fetch 和生成的证书。
- **没有在真实打印机上验证 FFmpeg 的 RTSPS 互操作。** `:322` 路径的证书核对和进程顺序有测试，但「某台具体固件的 RTSPS 流能不能被本机 ffmpeg 解出来」不在测试覆盖里。
- **TUTK 桥是预编译二进制。** 自带桥有 `SHA256SUMS` 校验；清单缺失会跳过（老版本兼容），自定义桥不在清单里。这是供应链边界。
- **复查当天记录 422 项通过；重写文档时重跑 471 项通过。** 数字会随测试增加变化，不要把 422 当成永久值。

---

## 怎么读这份记录

- 想知道「现在怎么用」：看 [README.md](../README.md)。
- 想知道「面板接口返回什么」：看 [ROUTES.md](ROUTES.md)。
- 想知道「云端画面怎么走」：看 [TUTK.md](TUTK.md)。
- 想确认某个修复还在：按上面的链接点进代码/测试；测试名就是 `test(...)` 的第一个参数。
