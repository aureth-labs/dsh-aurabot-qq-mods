# 拓竹打印机：代码是怎么搭起来的

给改代码的人看的内部说明。想装、想用，先看 [README.md](../README.md)；登录网页怎么走，看 [ENROLL.md](ENROLL.md)；信封格式，看 [ENVELOPE.md](ENVELOPE.md)。

模块声明在 [module.json](../module.json)：id 是 `bambu-print`，名字「拓竹」，版本 1.1.1，api 1，minPluginVersion 1.2.0，能力是 network / filesystem / process / plugin-config / plugin-internals。代码只 import `node:` 内置模块和仓库里的相对路径，没有第三方依赖。

三句话先记住：

1. **数据从哪来**：QQ 消息进 `index.mjs`，它按需去连打印机（云端 MQTT，或局域网 8883 / 6000 / 322 三个端口）；云端账号登录走 `lib/cloud-auth.mjs`。
2. **权限在哪判**：`lib/policy.mjs` 算「这个人能不能做这类事」，`index.mjs` 的 `gate()`、`ensureControl()`、`ensurePhoto()` 决定「这一次给不给」。
3. **秘密怎么存**：每个 QQ 一把随机 32 字节的 DEK（数据密钥），DEK 由本机的 `host-key.bin` 包着；token 和访问码只在进程内存里出现，落盘的是密文。

## 0. 安全底线（改任何文件之前先看）

这五条不是建议，是写在代码和测试里的规则：

1. 明文秘密只活在局部变量里。不进日志、不进返回值、不进面板、不进审计备注、不进命令行参数。
2. 落盘只有密文。数据目录 0700，文件 0600，写入先写临时文件再改名，避免写一半。
3. 没确认过对端身份，就不发凭据。局域网证书没固定过，宁可报错也不「先连上试试」。
4. 拿不到数据就说「不知道」。缺字段写 null 或「未知」，不用 0 和假数据顶上去。
5. 群聊默认脱敏。要显示文件名，得三个条件同时成立（见第 5 节）。

## 1. 一条消息的旅程

一条「/打印机 状态」大概这样走：

```
QQ 消息
  │
  ▼
index.mjs   api.on('message') → handleCommand()
  │  ① 总开关关着？回一句，结束
  │  ② gate()：私聊/群聊、白名单、多用户模式
  │  ③ 找打印机：vault.printers()，多台就反问
  ▼
endpointOf() 选接口：云端还是局域网
  │
  ▼
printer.mjs → mqtt.mjs（8883）或云端区域主机
  │  ④ 局域网第一次连接：ensureCert() 只握手读证书
  ▼
normalizeStatus() → formatStatus()：中文、行数固定、按需脱敏
  │
  ▼
audit() 记一行 → api.reply() / 合并转发 / 图片
```

面板和网页走同一条骨架：路由进来，先 `ready()`，再判主人和会话，再调保险箱或协议层，最后只回元数据。

## 2. 四块，各自解决一个麻烦

### 2.1 准入与权限：谁能在哪台机器上做什么

**为什么需要它**：机器人一开口就代表机器。不先判身份，任何陌生人都能用别人绑定的打印机，或者把访问码骗出来。

入口只有一个 `index.mjs`。它在 `setup(api)` 里读设置、建保险箱、建信封服务、建打印机管理器，然后注册命令、模型工具和面板路由。

- **名单不自己存**。`hostPrivateAllow()` 直接读宿主的 `cfg.allow.private`，再加上 `ownerQQ`；`hostGroupAllow()` 读 `cfg.allow.groups`。这两份组成 `settings.users` / `settings.groups` 交给 policy，所以不会出现「宿主放行、插件拦下」的两套名单。
- **身份只有三种**：主人、白名单用户、路人。没有「管理员」这一级。想让别人用你的打印机，走授权，不要提权。
- **私聊**：主人或名单里的人。**群聊**：群在名单里，且发起人自己有绑定或有效授权。
- **群模式** `groupMode` 三档：`off` 不响应、`status` 只读、`control` 允许控制。绑定者可以在私聊用 `/打印机 群权限` 给自己的打印机再收紧或放宽，判定顺序是「绑定者的偏好 > 全局设置」。控制永远只作用于发起人自己的（或别人授权给他的）打印机，不会落到第三个人头上。
- **敏感操作只走私聊**：登录、绑定、解绑、授权、撤销、接口、群权限、证书、锁定、验证码。群里发会先在 `handleCommand` 顶部被拦掉，回「这个操作只能在私聊里做」。
- **两根刹车**：同一个人 60 秒 20 条（只防刷屏，不参与安全判定）；停止打印要 1 分钟内再发一次带「确认」的，代码里用 `pendingStop` 记着。
- **多台要选**：选择结果按 `chatId` 记 `selectedTtlMinutes` 分钟（默认 10，可调 1~60）。
- **两个开关的差别**：`active` 关掉，连帮助都不回；`multiUser` 关掉，只服务主人，其他人（包括已经绑定、拿着授权的）一律静默不理，理由是别让人知道这儿有个只服务主人的机器人。

### 2.2 保险箱：秘密只在这里进出

**为什么需要它**：聊天记录是长期明文，秘密不能待在那里；但机器人重启后还得能读，所以只能「落盘即密文，用时才解开」。

- 每个 QQ 在 `vault.json` 里一条记录，里面有两个盒子：
  - `wrapped`：这把 DEK 被 `host-key.bin` 包起来的密文（AES-256-GCM，AAD 是 `user:<qq>`）。
  - `payload`：绑定数据（含 token、访问码、证书 PEM）被 DEK 加密的密文，AAD 一样。
  - 另外有一份 `meta` 明文镜像，只放 id、名称、模式、序列号、IP、名字、型号，用来在会话没开的时候列清单。它永远不含秘密。
- `host-key.bin` 是 32 字节随机数，0600，第一次用到时生成，和 `vault.json` 放一起。它包所有人的 DEK。
- **所以隔离靠代码，不靠密码学**：一把主机钥匙能解开所有人的记录。拿到整个数据目录的人，等于拿到所有人的凭据。这条要一直写在帮助第 2 页里，别删。
- `sessions` 里只放 DEK 和到期时间，默认 7 天（`unlockDays`，可调 1~30 天）。`/打印机 锁定` 立刻清，扩展被卸载时（`api.onDispose`）也会清。
- 启动时 `load()` 会调用 `#warmAll()`，把所有能解开的记录预热进会话；除此之外，聊天命令、选打印机的那条回复、模型工具在执行前都会 `ensureSession()` 再补一次。也就是说「解锁」只是一个缓存开关，不是身份验证。
- **会话对所有账号一视同仁地自动续**：锁过、闲置到期之后，下一条聊天命令、下一条「第几台」、或者一次模型工具调用都会先把会话补回来，不会要求用户重新登录。还没收敛的是**面板 HTTP 路由**：它们不会自动补会话（`/status`、`/control`、`/photo` 需要调用方先 `/unlock` 或发一条命令），排查时要知道这个差别。
- **授权（grant）**：`grants.json` 里只记「谁授权给谁、哪几个绑定、什么范围（`status` / `control` / `photo`）、到什么时候」，没有秘密，也没有能解出秘密的密钥。受权人操作时，用所有者的 DEK 现解现用，所以所有者必须处在一个有效会话里，否则报 `OWNER_LOCKED`。默认 30 分钟，最长 1440 分钟，随时能撤销，到期自动失效。
- **审计**：`audit.jsonl` 一行一条，字段只有 `at / actor / action / ok / target / note`。`note` 会把换行压成空格、截到 160 字；token、访问码、文件名都不往里写。文件到 2MB 就改名成 `audit.1.jsonl`，只留一代；内存里最多保留最近 2000 条给面板读。
- **登录信封的私钥**单独一份 `bbx-key.json`，用过的 `jti` 记在 `bbx-used.json`，细节见 [ENVELOPE.md](ENVELOPE.md)。

密钥材料都在 `lib/crypto.mjs`：AES-256-GCM（12 字节 IV，16 字节 tag），scrypt 参数常量 `DEFAULT_KDF` 还在（N=32768、r=8、p=1）。但 `vault` 已经不再调用 `deriveKey()` / `checkCodeStrength()`；这两个函数只剩单元测试在覆盖，留着是为了不改导出。

坏文件不会被悄悄清空：`load()` 遇到解析失败直接抛 `BAD_FILE`，让你去修，而不是把用户数据重置成空库。

### 2.3 协议：怎么跟打印机说话

**为什么需要它**：打印机不认 QQ 号，只认 token 或访问码；而它的局域网证书是自己签的，公共 CA 验不过。这一层负责把「用户身份」换成「对某个对端的凭据」，并且不把凭据交给不认识的对端。

五条链路，保护方式不一样：

| 链路 | 端口 | 对端 | 用什么凭据 | 怎么确认对端 |
|---|---|---|---|---|
| 云端 MQTT | 8883 | `us/eu/cn.mqtt.bambulab.com` | 用户名 `u_<uid>`，密码是 access token | 系统 CA + 主机名校验 |
| 局域网 MQTT | 8883 | 打印机 IP | 用户名 `bblp`，密码是访问码 | 先学后固定（见第 3 节） |
| 摄像头 MJPEG | 6000 | 打印机 IP | 80 字节认证包（里面是访问码） | 没有锚点就不抓 |
| 摄像头 RTSPS | 322 | 打印机 IP | ffmpeg 从 stdin 读到的 concat 脚本（里面有 URL） | 启动 ffmpeg 之前先比对指纹 |
| 云端画面 | TUTK | ThroughTek 的 P2P | 云端铸的 ttcode | 交给抓帧桥，细节见 [TUTK.md](TUTK.md) |

- **云端登录** `lib/cloud-auth.mjs`：`POST /v1/user-service/user/login`。云端可能要求邮箱或短信验证码（短信只有中国站提供，路径多一层 `/api`），也可能要求两步验证（先 `GET /api/csrf`，再 `POST /api/sign-in/tfa`）。等验证码或两步验证的登录会话只在内存里留 5 分钟，密码只用于这一次登录。OAuth 注册的账号要先去 Bambu 手机 App 里设密码。
- **区域** `lib/cloud.mjs`：`us` / `eu` 的 API 是 `https://api.bambulab.com`，`cn` 是 `https://api.bambulab.cn`；MQTT 主机分别是 `us.mqtt.bambulab.com` / `eu.mqtt.bambulab.com` / `cn.mqtt.bambulab.com`，端口都是 8883。两步验证走网页域名 `bambulab.com` / `bambulab.cn`。
- **设备列表** `lib/cloud.mjs`：`GET /v1/iot-service/api/user/bind`，超时 12 秒；错误信息只报状态码，不回显 token。
- **状态** `lib/status.mjs`：纯函数。`normalizeStatus()` 把 MQTT 上报的 JSON 归一成固定字段，字符串数字转 number，缺的一律 null；`formatStatus()` 负责排版，并用 `redactName` / `redactProject` 控制脱敏。
- **命令** `lib/printer.mjs`：同一台打印机复用连接，状态缓存 3 秒，空闲 120 秒断开，命令回执最多等 2.5 秒（超时算发出去了但没回执）。gcode 一次不超过 2000 字符；速度 1~4；温度喷嘴上限 300、热床上限 120。
- **MQTT 细节** `lib/mqtt.mjs`：keepalive 60 秒（每 30 秒发一次 PINGREQ），连接超时 8 秒，单个报文上限 4 MB。订阅 `device/<serial>/report`，往 `device/<serial>/request` 发命令；回执用 `sequence_id` 匹配。带凭据又没有锚点时，客户端在发 CONNECT 之前就抛 `INSECURE_CREDENTIALS`（只有 `learnOnly` 的读证书握手例外）；云端从不用锚点，只信系统 CA。
- **命令负载** `printer.buildCommand()`：`pause` / `resume` / `stop`、`light`（`ledctrl` 的 `chamber_light`）、`speed`（`print_speed` 1~4）、`temperature`（`gcode_line` 发 `M140` / `M104`）、`gcode`、`home`（`G28`）、`pushall`。
- **选接口** `endpointOf()`：非主人只能云端；主人按「自己的偏好 > `defaultInterface`」选，`auto` 是有云端凭据就云端；`ownerLocalAllowed=false` 时连主人也强制云端。被授权的打印机按「和绑定者同等」处理，否则主人绑的局域网打印机一授权出去就不能用。
- **抓帧** `lib/camera.mjs`：6000 是「80 字节认证包 + 16 字节帧头 + JPEG」，只接受 JPEG，单帧上限 8MB；322 是 H.264，必须借本机 ffmpeg 截一帧（默认超时 20 秒，上层传 15 秒）。
- **云端画面** `lib/tutk.mjs` + `lib/tutk-bridge.mjs`：先用 token 铸 ttcode，把 `bambu:///tutk?...` 写进 0600 临时文件（不放进命令行参数），交给 `assets/tutk-bridge` 里的小 C 程序；它运行时加载 BambuSource 库，H.264 再交给 ffmpeg。库可以通过面板下载，默认落在数据目录的 `bambusource/`。打洞失败时会走 ThroughTek 的公网中继，公开资料记作 :3478；这一条不在本仓库代码里，属于桥和厂商库的行为（未确认）。
- **发现** `lib/discover.mjs`：往 `239.255.255.250:1990` 发 SSDP 探测，打印机在 UDP 2021 回包。只拿到序列号、IP、名字、型号、信号，访问码不会广播。

### 2.4 界面：把结果变成一句话

**为什么需要它**：同一个事实要在聊天、面板、网页三个地方出现，三处必须一个口径；否则用户看到的就是「按钮说一套、机器人做一套」。

- **聊天**：`handleCommand()` 一条命令一个 `if`，参数解析很土但直白。帮助固定 6 页（主人多看第 7 页「局域网」），用合并转发一次发完；宿主不支持就退回分页纯文本。多台打印机也用合并转发列，回复编号照样能选。
- **自然语言**：注册了一个 `bambu_printer` 工具，只在消息里明确提到打印机时才接管；工具不下发停止（停止必须本人用命令二次确认）。
- **面板** `panel.js`：6 个页签，总览 / 登录信封 / 局域网绑定 / 设置 / 审计 / 帮助。设置页不自己维护表单规则，从 `/overview.rules` 读第 6 节那张表；改值只进草稿，落盘靠宿主页面底部的「保存设置」。
- **面板接口**：清单和错误码见 [ROUTES.md](ROUTES.md)。共同约定是只回元数据：QQ 打码、token 掩码、序列号打码、IP 打码；只有「操作者是谁」给完整 QQ，因为面板跑在本机主人自己的浏览器里，打码了反而认不出人。没有导出 token / 访问码的接口。
- **登录网页** `assets/enroll/`：纯静态文件，只能用公钥加密。流程、可信边界见 [ENROLL.md](ENROLL.md)。
- 回复有三种形态：字符串、`{ image }`、`{ forwardNodes, fallback }`。

## 3. 局域网证书：先学后固定

打印机的 8883 / 6000 / 322 用的都是它自己生成的证书，CN 是序列号不是 IP，公共 CA 链不存在。直接关掉校验（`rejectUnauthorized: false`）等于不校验，同网段任何人都能冒充打印机，访问码就交出去了。

所以走 TOFU，意思是「第一次连接时记住打印机这张证书，以后只认这一张」。三个端口分开做，因为端口不同、证书也可能不同：

| 端口 | 用途 | 第一次怎么学 | 以后怎么校验 | 没有固定记录时 |
|---|---|---|---|---|
| 8883 | MQTT 状态与控制 | `learnOnly` 只做 TLS 握手，拿到证书立刻断开，一个字节的 MQTT 都不发 | 拿这张证书当 `ca` 锚点，`rejectUnauthorized: true`，同时核对指纹 | 不建连接、不发访问码（`CERT_UNPINNED`） |
| 6000 | A1 / A1 mini / P1P / P1S 的 MJPEG 画面 | 同样只握手读证书 | 锚点严格校验，通过后才发 80 字节认证包 | 直接不抓拍（`CAMERA_UNPINNED`） |
| 322 | X1 系列 / H2 / H2D / P2S / X2D 的 RTSPS 画面 | 同样只握手读证书 | ffmpeg 不认自签名 CA 也没有 pin，所以**在启动 ffmpeg 之前**自己握手、比对指纹 | 不启动 ffmpeg（`RTSPS_UNPINNED`），访问码连 stdin 都没进过 |

几个容易踩的点：

- 证书存在每个用户保险箱里：`printer.certs.mqtt` / `certs.camera` / `certs.rtsps`，每个槽放 PEM、SHA-256 指纹、subject、到期时间、固定时间。**三个槽不能混**：322 的证书和 6000 的不是同一张，以前共用一个槽会把控制面的锚点覆盖掉。
- 证书永远记在**绑定者**名下（`printer.ownerQQ`）。受权人代拍时，如果绑定者当前没有会话，证书只挂在这一台的内存对象上，不落盘，下一次还要重新学。
- 证书变了报 `CERT_CHANGED`，不覆盖旧记录。确认是自己重刷了固件，再私聊发 `/打印机 证书 信任` 重新固定；`/打印机 证书` 能看到三个端口各自的指纹。被授权用户看到提示时，话术指向绑定者，因为他才能重新固定。
- 云端正好相反：只信系统 CA，target 上误带的 `tlsCa` / `tlsFingerprint` 一律忽略，绝不因此降级。
- 这条链路真正的前提是「第一次连接那一刻没有中间人」。要彻底排除，只能带外核对指纹：`/打印机 证书` 显示的指纹，和你从打印机屏幕上看到的核对一致。
- 322 这条比另外两条弱一档：校验做在 ffmpeg 外面，所以它能挡住「握手时对端换了」，但挡不住同网段有人做主动中间人（ARP 欺骗之类）后伪造整条画面。日常看进度、暂停、调温根本不走 322。

## 4. 数据目录与文件

数据都在 `api.dataDir()` 下，默认是 `modules-data/bambu-print/`。目录 0700，文件 0600，所有写入都是「临时文件 + fsync + 改名」。

| 文件 | 里面是什么 | 有没有秘密 |
|---|---|---|
| `vault.json` | 用户记录、加密的 DEK、加密的绑定数据、明文 meta 镜像、偏好 | 只有密文和元数据 |
| `grants.json` | 授权的元数据（谁给谁、哪几个绑定、范围、到期） | 没有，也没有能解密的材料 |
| `audit.jsonl` | 操作记录，一行一条 JSON | 没有 |
| `audit.1.jsonl` | 上一代审计，超过 2MB 时轮转出来 | 没有 |
| `host-key.bin` | 32 字节主机密钥，包所有人的 DEK | **是秘密** |
| `bbx-key.json` | 登录信封的 P-256 私钥（JWK），0600 | **是秘密** |
| `bbx-used.json` | 用过的信封 jti 和它们的过期时间 | 没有 |
| `bambusource/` | 面板下载的 BambuSource 库，运行时被桥加载 | 没有 |

`vault.json` 的形状：

```json
{
  "v": 1,
  "users": {
    "<qq>": {
      "v": 1,
      "wrapped": { "v": 1, "iv": "<b64>", "tag": "<b64>", "data": "<b64>" },
      "payload": { "v": 1, "iv": "<b64>", "tag": "<b64>", "data": "<b64>" },
      "meta": { "bindings": [ { "id": "b_xxx", "label": "我的 A1", "mode": "lan",
                  "createdAt": 0, "printers": [ { "serial": "...", "ip": "192.168.1.50",
                  "name": "A1", "model": "A1" } ] } ] },
      "createdAt": 0, "updatedAt": 0, "lastSeenAt": 0,
      "prefs": { "groupShowName": false, "selectedPrinter": "", "interface": "",
                 "groupMode": "", "groupPhoto": null }
    }
  }
}
```

- `payload` 解开后是 `{ v: 1, bindings: [...] }`。每条绑定有 `id / label / mode / secret / printers / createdAt`；云端绑定多一个 `discoveredAt`。
- 每台打印机可以带 `certs`（三个槽）和自己单独的 `accessCode`（覆盖绑定级访问码）。
- 代码不再写 `attempts`、失败计数或锁定时间。旧文件里就算还留着这些字段，也没人读；`listUsers()` 返回的 `lockedUntil` 恒为 0。
- 坏文件不静默重置：空文件、非 JSON、结构不对，都抛 `BAD_FILE`。

`grants.json` 的形状：

```json
{ "v": 1, "grants": [ { "id": "g_xxx", "ownerQQ": "111", "granteeQQ": "222",
  "scopes": ["status", "control"], "bindings": [ { "id": "b_x", "label": "我的 A1",
  "mode": "lan", "printers": [ { "serial": "...", "name": "A1", "model": "A1" } ] } ],
  "createdAt": 0, "expiresAt": 0, "revokedAt": 0 } ] }
```

审计一行长这样，`note` 是唯一自由文本，已经在入口截断和去换行：

```json
{ "at": 1710000000000, "actor": "111", "action": "bind", "ok": true,
  "target": "b_xxx", "note": "lan 绑定「我的 A1」1 台" }
```

卸载模块不会删这个目录。要彻底清掉就手动删，删了无法恢复，只能重新登录和绑定。

## 5. 脱敏规则

一条原则：**秘密永远不出现，人只看得出「是谁的哪一台」**。

| 东西 | 怎么显示 | 代码 |
|---|---|---|
| QQ 号 | `123****456`（太短整段遮住） | `policy.maskQQ` |
| IP | `192.168.*.*`（IPv6 只留前两组） | `policy.maskIp` |
| 序列号 | 前 4 位 + `••••` + 后 3 位（6 位以内只留前 2 位 + `••`） | `index.maskSerial` |
| token / 访问码 | `••••` + 末 4 位；短值整段遮 | `crypto.maskSecret` |

群聊状态默认两个都藏：文件名显示「已脱敏」，项目名永远不显示。要放开文件名，必须同时满足三个条件：

1. 提问的人就是这台打印机的绑定者；
2. 他自己开了 `prefs.groupShowName`（`/打印机 群权限 文件名 开`）；
3. 全局设置 `allowGroupName` 也开着。

`hideProject` 在群里恒为 true（`policy.redaction`）。私聊不脱敏。

面板和接口只给打码值：`tokenMask`、`serialMasked`、`ipMasked`；审计的 `actor` 给完整 QQ。信封的日志只记错误码、类型、ttl 和 jti 的前 6 个字符；协议层的错误文本会先把访问码、token 擦掉再往外抛（`printer.sanitizeError`、`camera.scrub`、`tutk.scrubSecrets`）。

## 6. 设置：一张表说了算

`lib/settings.mjs` 的 `SETTING_RULES` 是唯一真相。面板、`/overview.rules`、启动归一化、运行时夹取，读的都是这一份。

- `normalizeSettings(raw)` 只输出表里列出的键，越界夹取，类型不对回默认值。宿主或旧版本塞进来的 `enabled`、`users`、`__panelGroup` 这类键会被丢掉。
- 面板从 `/overview.rules` 拿 `describeRules()` 的结果渲染输入框，所以「能填什么」「保存时怎么夹」不会两样。
- 启动时会把存量设置按表归一化，只写有差异的键，不整份覆盖。
- 总开关叫 `active`，不叫 `enabled`。原因很现实：宿主看到 `enabled` 会在页面标题栏再画一个总开关，和面板里那个各写各的。`effectiveEnabled()` 只在老配置完全没有 `active` 时才回落到 `enabled`，升级不会把开着的人静默关掉。`index.mjs` 的 `defaults` 里故意不写 `active` 和 `enabled`。
- 交叉约束：`enrollMaxTtlMinutes` 不会小于 `enrollTtlMinutes`。
- 生效时机：点页面底部的「保存设置」。`unlockDays` 特殊一点，改完不用重启，最晚下一次解锁时生效。

| 键 | 类型 | 默认 | 范围 / 可选值 | 作用 |
|---|---|---|---|---|
| `active` | 开关 | 关 | 真 / 假 | 总开关 |
| `multiUser` | 开关 | 开 | 真 / 假 | 关掉只服务主人 |
| `groupMode` | 单选 | `status` | `off` / `status` / `control` | 群里的默认权限 |
| `groupPhoto` | 开关 | 开 | 真 / 假 | 群里能不能要画面 |
| `allowGroupName` | 开关 | 关 | 真 / 假 | 群里能不能显示文件名 |
| `defaultInterface` | 单选 | `cloud` | `cloud` / `lan` | 默认走哪个接口 |
| `ownerInterface` | 单选可空 | 空 | 空 / `cloud` / `lan` | 只影响主人 |
| `ownerLocalAllowed` | 开关 | 开 | 真 / 假 | 关掉后连主人也走云端 |
| `ownerNoCode` | 开关 | 开 | 真 / 假 | 见下方说明：现在不影响行为 |
| `unlockDays` | 整数 | 7 | 1~30（天） | 会话有效期 |
| `maxBindings` | 整数 | 5 | 1~20 | 每人最多几条凭据 |
| `requestTimeoutMs` | 整数 | 6000 | 2000~20000 | 等打印机回话的毫秒数 |
| `selectedTtlMinutes` | 整数 | 10 | 1~60 | 群里选过打印机后记多久 |
| `tutkBridgePath` | 文本 | 空 | 绝对路径或空 | 换一个抓帧桥 |
| `tutkLibPath` | 文本 | 空 | 文件路径或空 | BambuSource 库在哪 |
| `tutkTimeoutMs` | 整数 | 20000 | 3000~60000 | 云端抓一帧的毫秒数 |
| `enrollBaseUrl` | 文本 | 空 | http(s) 地址，长度小于 300 | 登录网页前缀 |
| `enrollTtlMinutes` | 整数 | 60 | 1~1440 | 只用于展示「建议生存时间」 |
| `enrollMaxTtlMinutes` | 整数 | 1440 | 1~1440 | 服务端接受的信封上限 |

两个要说明的地方：

- 面板的「设置」页目前没有渲染 `enrollBaseUrl` / `enrollTtlMinutes` / `enrollMaxTtlMinutes` 这三个键，它们只在规则表和接口里。要换登录网页地址，得直接改模块配置（见 [ENROLL.md](ENROLL.md)）。
- `ownerNoCode` 现在不影响任何行为：所有账号都由 `host-key.bin` 包着，解锁不收任何码；面板判断里还留着一个恒为 true 的 `codeless` 兼容字段，所以这个开关关掉也不会让谁「需要安全码」。

## 7. 文件清单

| 文件 | 干什么 |
|---|---|
| `index.mjs` | 装配层。准入、命令、模型工具、面板路由、证书学习、抓帧顺序、登录信封落地 |
| `panel.js` | 面板 6 个页签的全部界面 |
| `module.json` / `package.json` | 模块声明（id、版本、能力、默认设置） |
| `lib/settings.mjs` | 设置规则表与归一化 |
| `lib/policy.mjs` | 权限、群模式、脱敏、打码、限流、时长解析（纯函数） |
| `lib/vault.mjs` | 保险箱：用户记录、绑定、授权、审计、主机密钥、会话 |
| `lib/envelope.mjs` | 登录信封服务端：私钥文件、一次性、有效期、对外形状 |
| `lib/crypto.mjs` | AES-256-GCM、scrypt、包/解 DEK、掩码、擦 Buffer |
| `lib/tls-cert.mjs` | 自签名证书生成、解析、指纹、从 socket 取对端证书 |
| `lib/mqtt.mjs` | 最小 MQTT 3.1.1 客户端（CONNECT / SUBSCRIBE / PUBLISH / PING） |
| `lib/printer.mjs` | 连接复用、状态缓存、命令下发、证书门 |
| `lib/camera.mjs` | 6000 MJPEG 与 322 RTSPS 抓帧、读证书 |
| `lib/cloud.mjs` | 区域表、云端设备列表 |
| `lib/cloud-auth.mjs` | 云端账号登录、验证码、两步验证 |
| `lib/tutk.mjs` | 铸 ttcode、拼 `bambu://` URL |
| `lib/tutk-bridge.mjs` | 调抓帧桥、临时文件、超时 |
| `lib/tutk-lib.mjs` | 下载并放置 BambuSource 库 |
| `lib/discover.mjs` | 局域网 SSDP 发现 |
| `lib/status.mjs` | 状态归一化与中文排版（纯函数） |
| `assets/enroll/` | 静态登录网页（只加密） |
| `assets/tutk-bridge/` | 预编译的抓帧桥 + C 源码 |

## 8. 测试

在 `modules/bambu-print` 下跑：

```bash
node --test "test/*.test.mjs"
```

- 每个 lib 和入口都有对应的 `test/*.test.mjs`：正常、边界、错误码、失败路径。
- 「没有秘密泄漏」是硬断言：`vault.json`、`audit.jsonl`、`dashboard()`、`/overview` 的输出里都不许出现测试用的 token、访问码。
- scrypt 在测试里用低 N（1024）提速；MQTT 用假的 Duplex / 假客户端，不需要真打印机。
- 信封有互操作测试：浏览器那份 `bbx.js` 在 Node 里加密，服务端用真私钥解开；页面本身有静态检查（不许联网、不许本地存储、不许有安全码输入框），本机装了 Edge/Chrome 时会跑一次真浏览器端到端。
- 证书相关的负面用例都覆盖到了：没锚点不发访问码、证书变了拒绝覆盖、322 没 pin 不启动 ffmpeg。

## 9. 旧说法对照（改文档时最容易踩的坑）

| 旧文档里的说法 | 现在 |
|---|---|
| 每人一个安全码，用安全码加密/解锁 | 没有安全码。每人一把 DEK，由 `host-key.bin` 包着；`/打印机 解锁` 只回一句「已经取消」 |
| 连续错 5 次锁 15 分钟、第 10 次锁 60 分钟 | 没有失败计数。`FAIL_LOCK_TIERS` 常量还在 `vault.mjs` 顶部，但没有任何地方调用 |
| 授权码 + 兑换 | 没有授权码。`createGrant()` 返回 `grantId`，授权按 QQ 直接生效 |
| 有「管理员」这一级 | 只有主人、白名单用户、路人 |
| 插件自己维护私聊/群名单（`settings.users`） | 名单来自宿主的 `allow.private` / `allow.groups` |
| 私聊里帮忙撤回敏感消息（`delete_msg`） | 撤回整体移除，改成在风险提示里说明「私聊也会留明文」 |
| 云端模式不支持拍照 | 会回退到云端 TUTK 画面 |
| `/打印机 登录 <账号> <密码>` | 不再收。带参数时必须是 `BBX1.` 信封，否则回「这段不像是这台机器生成的登录信封（应该以 `BBX1.` 开头）」 |
| 设置里点「重置密钥」 | 面板没有这个按钮，也没有对应路由。`envelope.rotate()` 只有库函数 |
| `enrollKeyMode` / `enrollKeyPath` 是设置项 | 规则表里没有这两个键。信封服务构造时支持 `keyMode` / `keyPath`，但面板和命令都没有入口 |
| 测试文件不进发布包 | 未确认。`package.json` 里没有 `files` 字段 |

## 10. 代码注释里的旧节号

几个 lib 文件头部还按老编号引用 ARCHITECTURE 的章节，改文档时别把它们当失效链接：

| 注释里写的 | 现在看这里 |
|---|---|
| `crypto.mjs` 的「第 0/2 节」 | 第 0 节（安全底线）+ 第 2.2 节（保险箱） |
| `vault.mjs` 的「第 0/1/3 节」 | 第 0 节 + 第 2.2 节 + 第 4 节（数据目录） |
| `policy.mjs` 的「第 4 节」 | 第 2.1 节（准入与权限） |
| `test/panel.test.mjs` 的「第 0 节」 | 第 0 节（安全底线） |
