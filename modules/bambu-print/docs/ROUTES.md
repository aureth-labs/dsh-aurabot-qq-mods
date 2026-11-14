# 面板接口清单（bambu-print）

这份文件写给两种人：改面板的人，和排查「面板为什么报错」的人。它只讲面板和后端之间的 HTTP 接口，不讲聊天命令。

先记住一句话：**这些接口不会把访问码、云端 token、密码、TUTK 凭据交出来。** 它们只返回状态、打码后的元数据和错误原因。

## 先弄清四件事

### 1. 接口挂在哪、面板怎么调

所有路径都在下面这个前缀后面：

```
/aurabot/api/ext/bambu-print/
```

比如接口写的是 `/overview`，完整地址就是 `/aurabot/api/ext/bambu-print/overview`。

面板里用 `call(path, body?)` 调用：读数据一般不带 body，写操作把参数放进 body。后端注册路由时只按路径匹配，代码本身不检查 GET 还是 POST；本文标 GET/POST 只是沿用面板的习惯。

### 2. 返回长什么样

成功时没有统一的 `data` 包装，字段直接平铺在顶层，共同点是 `ok: true`：

```json
{ "ok": true, "until": 1790000000000 }
```

失败时通常是：

```json
{ "ok": false, "code": "BAD_INPUT", "message": "给人看的中文原因" }
```

不是每个失败都一定有 `code`。少数路径会直接把异常抛出去，由宿主处理，调用方不会拿到 `ok:false`。已知会这样的有：

- `/enroll`：设置里的「登录网页地址」不是 http(s) 开头或太长时，`link()` 直接抛错；
- 任何路由在 `ready()` 读保险箱失败时也会抛错；
- 路由自己的代码有未捕获异常时同样抛给宿主。

所以面板不能假设「只要不是 200 就一定有中文 message」，网络层/宿主层错误要单独兜。

### 3. 谁能调

**模块代码里没有「请求者是不是主人」这一层校验。** 面板路由默认跑在本机主人自己的浏览器里；代码只检查请求里带的 `qq` 有没有账号、有没有绑定，或者主人 QQ 有没有账号。也就是说：

- 谁能访问这个 HTTP 路由，谁就能调用它；
- 知道别人的 QQ，就能查到对方**打码后**的绑定列表、打印机名和型号（明文秘密仍然拿不到）；
- 绑定、解绑、授权、建号、解锁这些动作，模块层没有二次身份确认（停止打印有 `confirm`，退出云端账号也有 `confirm`）。

宿主有没有在 HTTP 层再加鉴权，不在本模块代码里，这份文件不能替它保证。实际部署时不要把 Aurabot 的管理端口直接暴露到公网。

### 4. 哪些东西绝对不返回

- 局域网访问码（Access Code）；
- 云端 access token、登录密码；uid 也不返回给面板；
- 登录信封里的账号密码明文；
- TUTK 的 `ttcode / authkey / passwd` 和 `bambu:///tutk?…` 完整 URL；
- 登录信封私钥；
- 桥的临时文件内容（TUTK URL、样本）也不返回；接口只给最后的 JPEG。

需要打码时，用的是下面这几个函数：

| 函数 | 规则 | 例子 |
|---|---|---|
| `maskQQ` | ≤3 位整段打码；4~6 位留首尾；≥7 位留前 3 后 3 | `123****456` |
| `maskSerial` | ≤6 位留前 2；更长留前 4 后 3 | `01S0••••789` |
| `maskIp` | IPv4 只留前两段；IPv6 只留前两组；非法值给 `***` | `192.168.*.*` |
| `maskSecret` | ≤8 位整段遮住；更长只留末 4 位 | `••••abcd` |

三个例外，都是故意的：

1. `/overview`、`/audit`、`/lan/status` 会给**完整 QQ**。面板在本机主人界面上要认出「这是谁」，打码反而没法用。
2. `/lan/discover` 会给**完整序列号和 IP**。它本来就是给绑定表单填空用的，但仍然没有访问码。
3. `/status` 的 `status` 对象里带原始 `fileName / projectName / gcodeFile / subtask`。传 `reveal:false` 只改 `text` 里的文件行，**不会清洗 `status` 对象**。如果你拿这个对象去群聊展示，要自己再脱敏。

---

## 全部接口一眼看

| 接口 | 面板现在用吗 | 一句话 |
|---|---|---|
| `GET /overview` | 用 | 面板打开/解锁后拉总览、设置规则、用户、授权、审计 |
| `POST /unlock` | 不用 | 老接口：把某个用户的密钥解进内存，不校验任何码 |
| `POST /lock` | 不用 | 清掉某个用户的内存密钥缓存 |
| `POST /interface` | 不用 | 改某个用户的接口偏好（cloud / lan / auto） |
| `POST /groupperm` | 不用 | 改某个用户自己的群权限和群内拍照/文件名 |
| `GET /bindings` | 不用 | 看某个用户的绑定列表（打码） |
| `POST /bind` | 不用 | 建一条绑定（云端或局域网），不做证书固定和试连 |
| `POST /unbind` | 不用 | 删一条绑定 |
| `POST /status` | 不用 | 查某台打印机状态（文本 + 结构化状态） |
| `POST /control` | 不用 | 暂停/继续/停止/灯/速度/温度/回零 |
| `POST /photo` | 不用 | 抓一帧画面，返回 data URL |
| `POST /grant` | 不用 | 把凭据限时授权给另一个 QQ |
| `POST /revoke` | 不用 | 撤销授权 |
| `POST /logout` | 不用 | 退出云端账号，删掉云端绑定 |
| `POST /login` | 不用 | 账号密码直登（兼容/测试路径，面板不提供入口） |
| `POST /login/code` | 不用 | 提交登录验证码 / 请求发码 |
| `POST /login/tfa` | 不用 | 提交两步验证码 |
| `GET /tutk/status` | 用 | 检查抓帧桥和 BambuSource 库在不在 |
| `POST /tutk/download` | 用 | 下载并放置 BambuSource 库 |
| `POST /tutk/mint` | 不用 | 只铸一次 ttcode，验证云画面是否可用，不抓帧 |
| `GET /enroll` | 用 | 登录信封页：链接、公钥、指纹、有效期 |
| `POST /enroll/inspect` | 用 | 预览一段信封，不消费、不返回秘密 |
| `GET /audit` | 用 | 最近的审计记录 |
| `POST /owner/nocode` | 用 | 主人建号并确保内存会话（名字是历史遗留，没有码） |
| `POST /lan/discover` | 用 | 搜索局域网打印机，填序列号和 IP |
| `POST /owner/unlock` | 用 | 主人解锁（不校验码） |
| `POST /owner/lock` | 用 | 主人清缓存 |
| `GET /lan/status` | 用 | 主人局域网绑定的只读列表 |
| `POST /lan/bind` | 用 | 主人绑定局域网打印机，并固定证书、试连一次 |

---

## 总览与账号状态

### GET /overview

**什么时候调**：面板打开、主人解锁/锁定后、局域网绑定成功后重新拉总览。它一次给齐面板顶部、总览页和设置页要用的数据。

**谁能调**：没有调用者校验。所有人数据都会返回（QQ 完整、序列号/token 打码）。

**成功返回**：

```text
{
  ok: true,
  enabled: 总开关真值,
  settings: {
    users, hostAllow, groups, hostGroupAllow,
    groupMode, groupPhoto, allowGroupName,
    unlockDays, unlockMinutes,
    defaultInterface, ownerInterface, ownerLocalAllowed,
    tutkBridgePath, tutkLibPath, tutkTimeoutMs,
    tutkBuiltinBridgePath
  },
  rules: { 每个设置项的 kind / def / min / max / values / label / hint },
  owner: {
    qq, qqMasked, online, lanAllowed, unlockDays,
    noCode, codeless, hasAccount
  },
  users: [ {
    qq, qqMasked, bindings, printers, unlocked, lockedUntil,
    createdAt, lastSeenAt, interface, groupMode, groupPhoto, groupShowName,
    bindingList: [ {
      id, label, mode, tokenMask,
      printers: [ { serialMasked, name, model } ]
    } ]
  } ],
  grants: [ { id, ownerMasked, granteeMasked, scopes, expiresAt, revoked } ],
  audit: [ { at, actor, actorMasked, action, ok, note } ],
  counts: { users, boundUsers, bindings, printers, unlocked, activeGrants }
}
```

细节：

- `settings.users` 是私聊准入名单（Aurabot 的 `allow.private` 加主人），`hostAllow` 是同一份名单的数组形式；`groups` / `hostGroupAllow` 同理。重复是代码原样，不是两种不同名单。
- `settings` 只放面板设置页要用的那部分；`rules` 才是完整设置规则表，包含 `active`、`multiUser`、`ownerNoCode`、`maxBindings`、`enroll…` 等没有出现在 `settings` 里的键。
- `owner.online` 和 `users[].unlocked` 表示「内存里有没有这个用户的解密会话」。启动时会把能解开的账号都预热，所以平时通常是 `true`；`/owner/lock` 之后会变 `false`。
- `owner.noCode` 是把设置 `ownerNoCode` 原样报给面板（默认 `true`）。**代码里没有分支读这个开关**：`/owner/nocode` 和 `/owner/unlock` 都是无条件解锁，面板上的「主人免码（历史开关）」改了也不影响行为。
- `owner.codeless` 恒为 `true`，只是老面板兼容字段。
- `lockedUntil` 恒为 `0`：现在没有「错码锁定」这回事，字段保留是为了老面板不报错。
- `bindingList[].tokenMask` 只有在内存里能解开该用户数据时才有值；锁着时是空串。即便如此也只给末 4 位，不给明文。
- `audit` 是最近 50 条，新的在前；`actor` 是完整 QQ。
- `counts` 来自 `vault.summary()`：`users` 账号数，`boundUsers` 有绑定的账号数，`bindings` 凭据条数，`printers` 打印机台数，`unlocked` 当前有内存会话的账号数，`activeGrants` 未撤销且未过期的授权数。

**`rules` 里的默认值和范围**（和 `lib/settings.mjs` 的 `SETTING_RULES` 同一份，面板按它渲染）：

| 设置键 | 默认 | 范围 / 可选值 |
|---|---|---|
| `active` | 关 | 总开关；入口标签的小圆点读它 |
| `multiUser` | 开 | 关掉后只服务主人 |
| `groupMode` | `status` | `off` / `status` / `control` |
| `groupPhoto` | 开 | 群里是否允许拍照 |
| `allowGroupName` | 关 | 群里是否显示文件名 |
| `defaultInterface` | `cloud` | `cloud` / `lan` |
| `ownerInterface` | 空（跟随默认） | `cloud` / `lan` |
| `ownerLocalAllowed` | 开 | 主人能不能走本地接口 |
| `ownerNoCode` | 开 | 只影响展示；当前代码没有按它分支 |
| `unlockDays` | 7 | 1~30 天 |
| `maxBindings` | 5 | 1~20 条 |
| `requestTimeoutMs` | 6000 | 2000~20000 毫秒 |
| `selectedTtlMinutes` | 10 | 1~60 分钟 |
| `tutkBridgePath` | 空 | 留空用自带桥 |
| `tutkLibPath` | 空 | 留空按设置/环境变量/桥同目录找库 |
| `tutkTimeoutMs` | 20000 | 3000~60000 毫秒 |
| `enrollBaseUrl` | 空 | 留空用内置 GitHub Pages |
| `enrollTtlMinutes` | 60 | 1~1440 分钟 |
| `enrollMaxTtlMinutes` | 1440 | 1~1440 分钟，且不低于 `enrollTtlMinutes` |

注意表里的 `ownerNoCode` 和 `active` 是设置项；`/overview.settings` 里不一定有它们，面板要从 `/overview.rules` 和宿主设置里读。

**会被拒绝吗**：没有参数校验；保险箱读不出来时会抛错。

### POST /owner/nocode

**什么时候调**：面板上的「建立账号」；主人还没有账号时点它。名字里的 `nocode` 是历史遗留，现在没有安全码。

**谁能调**：主人 QQ 从 `api.config().ownerQQ` 取，不看请求 body；不需要请求里带 QQ。

**成功返回**：`{ ok: true, mode: "host", until }`。

行为：

- 主人账号不存在 → 用本机主密钥建一个，并直接开内存会话；
- 已存在 → 不动数据，只把会话打开；
- 重复点幂等，不会重置已有绑定；
- 每次都会把「解锁有效期（天）」同步到保险箱后再解。

**会被拒绝**：没读到主人 QQ → `NO_OWNER`；数据目录/主密钥有问题 → `FAILED` 或底层错误码（如 `BAD_FILE`）。

### POST /owner/unlock

**什么时候调**：面板上的「解锁主人」。

**谁能调**：主人 QQ 从配置取；body 不需要东西。

**成功返回**：`{ ok: true, until, unlockDays }`。`unlockDays` 取设置里的天数（1~30，默认 7）。

**会被拒绝**：

- 没读到主人 QQ → `NO_OWNER`；
- 主人还没有账号 → `NO_USER`（message：「还没有账号：先在上面点一下建立账号。」）；
- 主密钥解不开 → `BAD_FILE` / `FAILED`。

**注意**：不校验任何码。所谓解锁只是把本机主密钥解开的密钥放进内存缓存。面板现在还会在 body 里带一个 `code`（输入框提示「随便填几个字即可」），后端完全忽略；这是面板的遗留 UI，不影响接口本身。

### POST /owner/lock

**什么时候调**：面板上的「锁定主人」。

**谁能调**：主人 QQ 从配置取。

**成功返回**：`{ ok: true }`。

行为：清掉主人的内存会话；不删数据，下次命令/解锁会自动恢复。没有账号也能返回成功，只要主人 QQ 读得到。

**会被拒绝**：没读到主人 QQ → `NO_OWNER`。

### POST /unlock

**什么时候调**：老面板或外部调用；当前面板不调。它是用户级的「把密钥解进内存」，不是权限门。

**参数**：`{ qq, code? }`。`code` 现在**被忽略**：`vault.unlock(qq, String(b.code || ''))` 的第二个参数根本没人用。

**成功返回**：`{ ok: true, until, unlockMinutes, unlockDays }`。`unlockMinutes` 是天数 × 1440；`unlockDays` 是四舍五入后的天数。

**会被拒绝**：

- QQ 不是 4~15 位数字 → `BAD_INPUT`（「QQ 号不对」）；
- 这个 QQ 没有账号 → `NO_USER`；
- 主密钥解不开 → `BAD_FILE`。

**已经不存在的老错误码**：`BAD_CODE`、`LOCKED_OUT`。现在没有输码、没有错码计数，也没有锁定超时。聊天里发「解锁」「设置安全码」「改安全码」这类老命令，只会收到一句「安全码已经取消了：不用设置、不用解锁、也不用改」，不会进入任何验证流程。

**不只主人**：所有用户都没有安全码。`/unlock` 对任何已有账号的 QQ 都是同一个动作——把本机主密钥解开的密钥放进内存；没有输入可以输错。

### POST /lock

**什么时候调**：老面板或外部调用；当前面板不调。

**参数**：`{ qq }`。不校验 QQ 格式，也不要求这个 QQ 有账号。

**成功返回**：`{ ok: true }`。

行为：清掉该 QQ 的内存会话并写一条审计。所有账号都一样：下一条聊天命令、选打印机的回复、模型工具调用都会自动恢复；面板路由不会自动恢复，见下面「锁定后会发生什么」。

---

## 登录信封（账号密码不进聊天）

### GET /enroll

**什么时候调**：打开面板「登录信封」页。

**谁能调**：没有调用者校验；这个接口只给公钥和链接，不给私钥。

**成功返回**：

```text
{
  ok: true,
  link: "登录网页地址#k=公钥",
  publicKey: "87 个字符的 b64url 公钥",
  baseUrl: "实际使用的网页地址",
  custom: 是否用了设置里的自定义地址,
  fingerprint: "8 位十六进制指纹",
  ttlMinutes: 建议有效期（分钟）,
  maxTtlMinutes: 服务端允许的最大有效期（分钟）,
  keyCreatedAt: 私钥生成时间（毫秒时间戳）,
  stats: { used: 最近用过的信封数 }
}
```

细节：

- 默认网页地址是 `https://cdcp998.github.io/dsh-aurabot-qq-mods/`；设置 `enrollBaseUrl` 可以换。换了之后链接前缀跟着换，私钥不换。
- `fingerprint` 是公钥 SHA-256 的前 4 字节，8 位十六进制；网页开头显示它，用来核对「这个网页是不是发给这台机器的」。
- `ttlMinutes` 默认 60，`maxTtlMinutes` 默认 1440；服务端只接受不超过最大值的信封。
- `stats.used` 是最近 24 小时仍可能有效的已用信封计数，不是总历史数。

**会被拒绝**：`enrollReady()` 失败 → `{ ok: false, code: "NOT_READY", message: "登录密钥还没就绪：数据目录可能不可写，检查 modules-data/bambu-print/ 的权限。" }`。

另外：如果设置里的网页地址不是 `http://` / `https://` 开头或长度 ≥300，`link()` 会抛 `BAD_INPUT`，这个路由没有 catch，调用方会拿到异常而不是 `ok:false`。

### POST /enroll/inspect

**什么时候调**：用户在「登录信封」页粘贴一段以 `BBX1.` 开头的文本，点预览。

**参数**：`{ text }`。

**谁能调**：没有调用者校验，也不需要 QQ。它只解密看元数据，不消费信封，不返回账号密码。

**成功返回**：

```text
{
  ok: true,
  kind: "login",
  ttlMin: 信封有效期（分钟）,
  expiresAt: 过期时间（毫秒时间戳）,
  region: "us" / "eu" / "cn",
  accountMasked: "a***@b.com" 或 "138****8000",
  hasAccount: true,
  hasPassword: true
}
```

**会被拒绝**：

- 服务没就绪 → `NOT_READY`；
- 不是本模块信封 → `BAD_FORMAT`；
- 版本/套件不支持 → `BAD_VERSION` / `BAD_SUITE`；
- 太长 → `TOO_LARGE`；
- 解不开/被改过 → `BAD_TAG`；
- 内容不对 → `BAD_PAYLOAD`；
- 过期 → `EXPIRED`；
- 签发时间比本机时间还晚 → `NOT_YET`；
- 数据文件读写失败 → `IO`。

---

## 云端账号登录（兼容路由，面板当前不提供入口）

聊天里的登录已经改成「离线信封网页」：用户打开链接，在浏览器里本地加密账号密码，把 `BBX1.…` 贴回聊天。下面三条 `/login*` 是旧协议/测试路径，仍然能用，但**面板没有表单会调它们**；它们会让账号密码经过一次 HTTP body 到本机后端，所以只适合本机调试或你自己写的可信客户端。

### POST /login

**参数**：`{ qq, account, password, region? }`。

**谁能调**：没有调用者校验；`qq` 必须是 4~15 位数字，并且这个 QQ 已经有账号（否则 `LOCKED`）。代码用 `isUsableNow(qq)` 自动补会话，但这只对已有账号有效。

**成功返回**：

```text
{
  ok: true,
  loggedIn: true,
  bindingId: "b_…",
  count: 发现到的打印机台数,
  names: ["A1", "P1S"],
  message: "登录成功，token 已加密保存"
}
```

如果云端要求验证码或两步验证，不返回 `loggedIn`，而是：

```json
{ "ok": true, "need": "code", "message": "云端要求验证码：先点「发送验证码」，再填收到的数字" }
```

`need` 可能是 `code` 或 `tfa`。登录会话只在内存里放 **5 分钟**（`LOGIN_TTL_MS = 5 * 60 * 1000`）。

**会被拒绝**：

- QQ 格式不对 → `BAD_INPUT`；
- 这个 QQ 还没账号 → `LOCKED`（message：「先解锁这个用户：登录成功后 token 会加密进他自己的保险箱」）；
- 没填账号 → `NO_ACCOUNT`；
- 没填密码 → `NO_PASSWORD`；
- 云端账号密码不对/被限流/超时等 → 透传云登录层的错误码（如 `AUTH_FAILED`、`RATE_LIMITED`、`CLOUD_DOWN`、`TIMEOUT`）；
- 云端返回不认识的形状 → `UNKNOWN`。

**注意**：每次登录成功都会 `vault.addBinding` 新建一条云端绑定，不会自动合并同一账号的旧绑定。重复登录会多出凭据；达到「每人最多凭据数」（默认 5）时会返回 `BAD_INPUT`（路由统一用 `explain()`，message 是「参数不对。」）。

### POST /login/code

**什么时候调**：`/login` 返回 `need:"code"` 之后；用户点「发送验证码」或提交验证码。

**参数**：

- `{ qq, send: true }`：请求云端发码；
- `{ qq, code }`：提交收到的数字。

**成功返回**：

发码：`{ ok: true, sent: true, channel: "email" | "sms", message: "验证码已发送（邮箱/手机）" }`。

提交：`{ ok: true, loggedIn: true, bindingId, count, names }`。

**会被拒绝**：

- 没有等待中的登录，或超过 5 分钟 → `NO_SESSION`；
- 提交失败 → `CODE_FAILED`、`CODE_EXPIRED`、`CODE_INCORRECT` 等云端错误码。

### POST /login/tfa

**参数**：`{ qq, code }`（6 位验证器码）。

**成功返回**：`{ ok: true, loggedIn: true, bindingId, count, names }`。

**会被拒绝**：没有等待中的两步验证/超过 5 分钟 → `NO_SESSION`；`TFA_FAILED`、`CSRF_FAILED` 等。

### POST /logout

**什么时候调**：面板里退出云端账号；当前面板没有这个按钮，但接口保留。

**参数**：`{ qq, confirm?: true }`。

**谁能调**：没有调用者校验；只要求这个 QQ 有账号。

**成功返回**：`{ ok: true, removed: 删掉的云端绑定条数, message: "已退出云端账号，删掉 N 条云端绑定" }`。

行为：只删 `mode === "cloud"` 的绑定，局域网绑定一条都不碰；单条删除失败会被忽略，不拖垮其余。

**会被拒绝**：

- 没账号 → `NO_USER`；
- 没有云端绑定 → `NO_CLOUD`；
- 没带 `confirm:true` → `NEED_CONFIRM`（「退出会删掉云端 token，需要确认」）。

---

## 绑定、接口偏好、群权限

### GET /bindings?qq=

**什么时候调**：外部调用/测试；当前面板不调，面板总览用 `/overview` 里的 `bindingList`。

**参数**：query 里的 `qq`。

**谁能调**：没有调用者校验；只要求这个 QQ 有账号。

**成功返回**：

```text
{
  ok: true,
  bindings: [ {
    id, label, mode, tokenMask,
    printers: [ { serialMasked, name, model } ]
  } ]
}
```

不返回 IP，不返回访问码/token 明文。锁着时 `tokenMask` 是空串。

**会被拒绝**：没账号 → `NO_USER`（第一条 message 是「这个 QQ 还没绑定」，不是「没有绑定打印机」）。

### POST /bind

**什么时候调**：老面板/外部调用；当前面板的局域网绑定走 `/lan/bind`，云端绑定走登录。

**参数**：`{ qq, label?, mode, accessCode?, accessToken?, uid?, region?, printers? }`。

**谁能调**：没有调用者校验；只要求这个 QQ 有账号。局域网分支还要求 `qq` 等于 `api.config().ownerQQ`。

**mode 的坑**：代码只认字符串 `"cloud"` 为云端；**其它任何值都按 `"lan"` 处理**。写错 `mode` 不会报错，会走局域网，非主人直接 `OWNER_ONLY`。

**局域网分支**：

- `printers` 是数组，每项 `{ serial, ip, name?, accessCode? }`；
- 路由先过滤：只保留 `serial` 非空、`ip` 匹配 `^\d{1,3}(\.\d{1,3}){3}$` 的行；
- 一台都不剩 → `BAD_INPUT`（「局域网绑定至少要一台打印机：序列号 + IP」）；
- 访问码可以放在绑定级 `accessCode`，也可以放在每台打印机的 `accessCode`；两边都没有 → 保险箱拒绝，`BAD_INPUT`；
- 保险箱还会校验序列号 `^[A-Za-z0-9._-]{4,40}$`、IP 形状、访问码格式、最多 `maxBindings` 条（默认 5，最大 20）。

成功返回：

```json
{ "ok": true, "binding": { "id": "b_…", "label": "你填的 label 或空串", "mode": "lan" } }
```

**这条路由不做证书固定，也不试连。** 想要「绑完立刻固定证书 + 探一次状态」，用 `/lan/bind`。另外返回里的 `label` 是请求里的值（没填就是空串），不是数据库里补的默认名，别拿它做展示。

**云端分支**：

- `accessToken` 至少 8 位、不能带换行；`uid` 必须是数字 QQ 形状；`region` 只认 `us/eu/cn`，其它回落 `us`；
- 建好绑定后调云端设备列表，成功就把发现的打印机写进绑定；失败不删绑定，只返回 `warning`。

成功返回：

```json
{ "ok": true, "binding": { "id": "b_…", "label": "…", "mode": "cloud" }, "warning": "" }
```

`warning` 可能是「云端账号下没发现打印机。」或「云端设备列表拉取失败：…」。

**会被拒绝**：

- 没账号 → `NO_USER`；
- 非主人做局域网绑定 → `OWNER_ONLY`；
- 参数不合法/超过绑定上限 → `BAD_INPUT`（路由统一用 `explain()`，message 是「参数不对。」，具体原因不会带出来）。

### POST /unbind

**参数**：`{ qq, bindingId }`。

**谁能调**：没有调用者校验；只要求这个 QQ 有账号。

**成功返回**：`{ ok: true }`。

**会被拒绝**：没账号 → `NO_USER`；绑定不存在 → `NOT_FOUND`；锁着时 `removeBinding` 会抛 `LOCKED`。

### POST /interface

**什么时候调**：老面板/外部调用；当前面板不调。改的是某个用户的接口偏好。

**参数**：`{ qq, value }`；`value` 只接受 `""`、`"cloud"`、`"lan"`、`"auto"`，会先 trim + 转小写。

**谁能调**：没有调用者校验；只要求这个 QQ 有账号。

**成功返回**：`{ ok: true, interface: "" | "cloud" | "lan" | "auto" }`。

**会被拒绝**：没账号 → `NO_USER`；值不合法 → `BAD_INPUT`；内存会话被清掉时 `setPrefs` 会抛 `LOCKED`。

**注意**：普通用户固定走云端，这个偏好对非主人基本不生效；主人和拿到授权的打印机才会按偏好/默认接口选择。

### POST /groupperm

**什么时候调**：老面板/外部调用；当前面板不调。改的是某个用户自己的群权限。

**参数**：`{ qq, groupMode?, groupPhoto?, groupShowName? }`。

- `groupMode`：`""`（跟随全局）/ `"off"` / `"status"` / `"control"`；
- `groupPhoto`：`null` 或 `""` 表示跟随全局；其它值只有严格 `true` 才算开；
- `groupShowName`：只有严格 `true` 才算开。

**谁能调**：没有调用者校验；只要求这个 QQ 有账号。

**成功返回**：`{ ok: true, prefs }`，`prefs` 形如：

```json
{ "groupShowName": false, "selectedPrinter": "", "interface": "", "groupMode": "", "groupPhoto": null }
```

**会被拒绝**：没账号 → `NO_USER`；群模式不合法或一个字段都没带 → `BAD_INPUT`；会话被清掉 → `LOCKED`。

---

## 查状态、控制、拍照

### POST /status

**参数**：`{ qq, selector?, reveal? }`。

**谁能调**：没有调用者校验；只要求这个 QQ 有账号。

**选打印机**：

- 这个 QQ 自己名下的绑定（`vault.printers(qq)`），不含别人授权给他的；
- `selector` 可以是编号 `1`、名字/绑定名/序列号的精确匹配，或唯一子串；
- 没传 `selector` 且只有一台 → 直接用；
- 没传且有多台 → 不报错，返回 `{ ok: true, needChoice: true, choices: [...] }`；
- 编号越界/找不到 → `NO_PRINTER`；
- 子串命中多台 → `AMBIGUOUS`（不是 `needChoice`）。

`choices` 每项：`{ index, label, name, model, serialMasked }`。

**成功返回**：

```text
{
  ok: true,
  text: "给人看的多行状态",
  status: { 结构化状态对象 },
  transport: "cloud" | "lan",
  printer: { name, model, label, serialMasked, ipMasked }
}
```

- `text` 末尾会加一行「通道：云端接口 / 本地接口」；
- `reveal` 默认 `true`：私聊口径，显示文件名和项目名；传 `reveal:false` 时 `text` 里文件行显示「文件：已脱敏」，项目名隐藏；
- **但 `status` 对象不做二次清洗**，仍然带原始 `fileName / projectName / gcodeFile / subtask`。要拿去群聊展示，必须自己再脱敏。

**会被拒绝**：

- 没账号 → `NO_USER`；
- 没绑定 → `NO_PRINTER`；
- 接口选不出来/没凭据 → `NO_CLOUD`、`NO_LAN`、`CLOUD_ONLY`；
- 证书和上次固定不一致 → `CERT_CHANGED`；
- 连不上/没状态 → `OFFLINE`。

### POST /control

**参数**：`{ qq, selector?, action, confirm?, on?, level?, nozzle?, bed? }`。

**谁能调**：没有调用者校验；只要求这个 QQ 有账号。

**动作**：`pause`、`resume`、`stop`、`light`、`speed`、`temperature`、`home`。**没有 `gcode`**（老文档写错了，路由白名单里没有它）。

参数细节：

- `stop` 必须带 `confirm: true`，否则 `NEED_CONFIRM`（「停止打印需要确认：再点一次「确认停止」」）；
- `light`：`on` 只要不是严格 `false` 就当开；
- `speed`：`level` 夹到 1~4；不是数字/0 时按 2；
- `temperature`：`nozzle` 和/或 `bed`，至少一个有限数字，否则 `BAD_INPUT`（「至少给一个温度」）；0 是合法值（关加热）；
- `home` 发 G28 回零，不需要确认。

**成功返回**：`{ ok: true, message }`，message 里会写走的是「云端接口」还是「本地接口」，以及打印机有没有回执。

**会被拒绝**：

- 没账号 → `NO_USER`；
- 动作不认识 → `BAD_INPUT`；
- 需要确认 → `NEED_CONFIRM`；
- 选打印机失败 → `NO_PRINTER` / `AMBIGUOUS` / `needChoice`（多台且没选时仍返回 `ok:true` + `needChoice`）；
- 底层失败 → 透传打印机层的 `code`（如 `CERT_UNPINNED`、`CERT_CHANGED`、`NO_CLOUD`、`NO_LAN`、`CLOUD_ONLY`），没有 code 时是 `PRINTER_ERROR`。

**注意**：这条路由只操作请求里那个 QQ 自己名下的打印机，不操作别人授权给他的。

### POST /photo

**参数**：`{ qq, selector? }`。

**谁能调**：没有调用者校验；只要求这个 QQ 有账号。

**选打印机**：和 `/status` 同一套规则；多台没选时返回 `ok:true + needChoice`。

**成功返回**：

```text
{
  ok: true,
  image: "data:image/jpeg;base64,…",
  printer: { name, serialMasked }
}
```

图片来自：

1. 有局域网 IP + 访问码 → 先固定/校验摄像头证书，再抓局域网（A1/P1 系列 `:6000` MJPEG；X1/H2/P2S/X2D `:322` RTSPS，需要 ffmpeg）；
2. 局域网不通、没有局域网信息，且这台是云端绑定 → 用该打印机所属用户的云端 token 铸 ttcode，走本机 TUTK 抓帧桥；
3. **纯局域网绑定失败不会回退云端**，直接报 `NO_LAN` 或证书错误；
4. 两条都不通 → 如实报缺什么（token / 桥 / BambuSource / ffmpeg / 超时）。

**大小边界**：局域网单帧上限 8MB（`MAX_FRAME_BYTES`）；TUTK 桥样本上限 16MB（`BRIDGE_MAX_BYTES`），桥内部自己写文件的上限是 64MB；接口不做二次压缩，也没有老文档说的「1.6MB 上限」。

**会被拒绝**：

- 没账号/没绑定/多台没选 → `NO_USER` / `NO_PRINTER` / `needChoice`；
- 局域网证书没固定 → `CAMERA_UNPINNED` / `RTSPS_CERT_UNPINNED` / `RTSPS_UNPINNED`；
- 证书变了 → `RTSPS_CERT_MISMATCH` / `CERT_CHANGED`；
- 没有云端 token → `NO_TOKEN` / `LOCKED`；
- 没有抓帧桥 → `NO_TUTK_TOOL`；
- 没有 BambuSource → `NO_BAMBUSOURCE`；
- 桥失败/超时/空样本 → `BRIDGE_FAILED` / `TIMEOUT` / `EMPTY_DUMP`；
- H.264 需要 ffmpeg 但没装 → `NO_FFMPEG` / `FFMPEG_FAILED`。

**注意**：这条路由只列自己名下的绑定，不列别人授权给他的打印机；聊天里的「拍照」是另一条路径，会算上授权。

---

## 授权

### POST /grant

**参数**：`{ qq, grantee, bindingIds?, scopes?, minutes? }`。

**谁能调**：没有调用者校验；`qq` 是打印机所有者，只要求这个 QQ 有账号。

**语义**：`qq` 把自己的凭据**限时借给** `grantee`。对方不需要兑换码，下一次命令立刻生效；对方拿到的是使用权，不是 token。

参数：

- `grantee` 必须是 4~15 位数字，不能等于 `qq`；
- `scopes` 是数组，只保留 `status` / `control` / `photo`；非法项被静默丢掉；数组为空或全被丢掉 → `BAD_INPUT`；不传 → 默认 `["status"]`；
- `minutes` 默认 30，范围 1~1440；**越界会被夹到边界，不报错**（`parseMinutes` 的行为）；
- `bindingIds` 为空/不传 = 这个 QQ 当前全部绑定；只要有一个 id 不属于他 → `NOT_FOUND`；
- 他一条绑定都没有 → 保险箱返回 `NOT_FOUND`；路由用 `explain()` 包一层，message 是「找不到这条记录。」。

**成功返回**：

```text
{
  ok: true,
  grantId: "g_…",
  expiresAt: 毫秒时间戳,
  scopes: ["status"],
  count: 被授权的绑定条数（不是打印机台数）,
  message: "已授权，立即生效；对方现在就能用你的凭据操作这些打印机，到期自动失效。"
}
```

**会被拒绝**：

- 没账号 → `NO_USER`；
- 对方 QQ 不对/授权给自己/范围为空 → `BAD_INPUT`；
- 绑定 id 不存在或没有绑定 → `NOT_FOUND`；
- 所有者内存会话被清掉 → `LOCKED`。

**代价**：授权的秘密不复制，受权人操作时从**所有者的保险箱现解现用**。所以所有者要保持解锁；所有者锁上后，受权人会收到「主人当前没解锁」之类的提示。

### POST /revoke

**参数**：`{ qq, grantId }`。

**谁能调**：没有调用者校验；只要求 `qq` 有账号。所有者本人或被授权人本人都能撤销；第三方 → `FORBIDDEN`。

**成功返回**：`{ ok: true }`。已经撤销过的再撤一次也返回成功。

**会被拒绝**：

- 没带 `qq` → `BAD_INPUT`（message 是「撤销授权必须由授权人本人解锁后操作」，但代码其实不检查解锁）；
- 没账号 → `NO_USER`；
- 授权不存在 → `NOT_FOUND`；
- 既不是所有者也不是被授权人 → `FORBIDDEN`。

---

## 局域网

### GET /lan/status

**什么时候调**：打开面板「局域网绑定」页。

**谁能调**：没有调用者校验；它只读主人名下的局域网绑定，主人 QQ 从配置取。

**成功返回**：

```text
{
  ok: true,
  ownerQQ: "完整主人 QQ",
  ownerMasked: "123****456",
  ownerOnline: true/false,
  unlockDays: 7,
  lanAllowed: 设置里的 ownerLocalAllowed,
  bindings: [ {
    id, label, tokenMask,
    printers: [ { serialMasked, name, model } ]
  } ]
}
```

只列 `mode === "lan"` 的绑定；不返回 IP，不返回访问码。保险箱读失败时 `bindings` 给空数组，接口仍然 `ok:true`，只写一条 warn 日志。

**会被拒绝**：没有参数校验；正常不会返回 `ok:false`。

### POST /lan/discover

**什么时候调**：面板「局域网绑定」页点「搜索局域网打印机」。

**参数**：`{ timeoutMs? }`，默认 3000 毫秒。代码直接 `Number(b.timeoutMs) || 3000`，没有上下限夹取。

**谁能调**：没有调用者校验；它只发 SSDP 探测，不带凭据。

**成功返回**：

```text
{
  ok: true,
  devices: [ { serial, ip, name, model, signal } ],
  port: 2021,
  note: "有设备/没设备时的说明"
}
```

- 序列号、IP 是**完整值**，因为要填绑定表单；仍然没有访问码；
- 名字截到 60 字，型号截到 30 字；
- 探测包发到 `239.255.255.250:1990`，打印机在 UDP `2021` 回；
- 没搜到时 `note` 会提示同网段/开机联网。

**会被拒绝**：扫描器失败 → `{ ok: false, code: "DISCOVERY_FAILED", message, devices: [] }`；代码异常也是这个码。

### POST /lan/bind

**什么时候调**：面板「局域网绑定」页点绑定。它比 `/bind` 多做两件事：固定证书、试连一次。

**参数**：`{ label?, accessCode, printers: [{ serial, ip, name? }] }`。

**谁能调**：没有调用者校验；主人 QQ 从配置取。还要求主人当前是解锁状态（`vault.isUnlocked`，不是安全码；面板绑定前会先建号/解锁）。

**校验顺序**：

1. 没读到主人 QQ → `NO_OWNER`；
2. `printers` 是数组，先按 `serial` 或 `ip` 非空过滤；一台都不剩 → `BAD_INPUT`（「至少要填一台打印机的序列号 + IP。」）；
3. 逐行检查 `SERIAL_RE`（4~40 位字母数字，可带 `. _ -`）和 `IPV4_RE`（形如 `192.168.1.50`）；第一行不合格就报 `BAD_INPUT`，并指出第几行；
4. `accessCode` 空 → `BAD_INPUT`（「要填打印机屏幕上那条访问码」）；
5. 进 `bindLan()`：主人校验 → `OWNER_ONLY`；没解锁 → `LOCKED`；保险箱再校验序列号/IP/访问码/绑定上限。

**成功返回**：

```text
{
  ok: true,
  binding: { id, label, mode: "lan" },
  count: 这次绑定的打印机台数,
  probe: { ok: true/false, message: "已连上打印机" / "暂时连不上…" },
  cert: { fingerprint256: "…", learned: true/false } 或 { error: "…" }
}
```

重点：**绑定成功不等于证书固定成功、也不等于连上了**。`cert.error` 和 `probe.ok:false` 都会照实返回，但 `ok` 仍然是 `true`，因为绑定记录已经写进去了。

**会被拒绝**：`NO_OWNER`、`OWNER_ONLY`、`LOCKED`、`BAD_INPUT`（含绑定数量到上限）。

---

## TUTK 组件

### GET /tutk/status

**什么时候调**：面板「设置」页点「检查 TUTK 组件」。

**谁能调**：没有调用者校验；只读文件，不连打印机，不回显任何凭据。

**成功返回**：

```text
{
  ok: true,
  bridge: {
    path: "实际使用的桥路径，可能是空串",
    builtin: 是否是模块自带的桥,
    customized: 是否在设置里填了自定义桥,
    ok: 桥文件存在/可执行/哈希对,
    code: "",
    message: ""
  },
  lib: {
    path: "找到的库路径，可能是空串",
    ok: 库文件存在且 ≥64KB,
    message: "",
    download: "https://github.com/ClusterM/open-bamboo-networking/releases",
    file: "BambuSource.dll" 或 "libBambuSource.so"
  },
  cn: 是否判断为国内网络,
  timeoutMs: 设置里的抓帧超时,
  note: "一段说明"
}
```

- `bridge.ok` 为 `false` 时 `code` 可能是 `NO_BRIDGE`、`MISSING`、`NOT_FILE`、`BRIDGE_HASH_MISMATCH`、`BRIDGE_UNREADABLE`；
- `lib.ok` 为 `false` 时 `bridge.ok` 仍可能是 `true`（桥在、库缺），面板要分开提示；
- 当前平台不是 Windows x64 / Linux x64 时，模块没有自带桥，`bridge.path` 会是空串，`bridge.ok` 为 `false`；
- `lib.path` 的查找顺序：设置 `tutkLibPath` → 环境变量 `BAMBU_SOURCE_LIB` → 桥同目录。**显式填了设置却找不到时直接算缺库**，不会偷偷换别的路径。

**会被拒绝**：正常不会；读文件失败会体现在 `bridge.ok` / `lib.ok` 里。

### POST /tutk/download

**什么时候调**：面板「设置」页点「下载 BambuSource 库」。

**谁能调**：主人 QQ 从配置取，并且主人账号必须存在、能被本机主密钥解开（`ensureOwnerSession()`）。这里的「解锁」不是安全码，只是内存会话；但主人还没建号时会返回 `LOCKED`。

**参数**：`{ dir?, cn?, timeoutMs? }`。

- `dir` 留空 → 用设置里的 `tutkLibPath`；再留空 → 用数据目录下的 `modules-data/bambu-print/bambusource/`；
- `dir` 既可以是目录，也可以是完整库文件路径（如 `/opt/libBambuSource.so`）。填文件路径时按这个名字落盘，不会多套一层目录；
- `cn` 不传则由本机时区/语言判断；
- `timeoutMs` 夹在 60000~600000 毫秒，默认 480000（8 分钟）。

**成功返回**：

```text
{
  ok: true,
  path: "最终落盘路径",
  bytes: 文件字节数,
  version: "v2.3.0",
  via: "实际下载的主机名",
  proxy: 是否走了代理,
  cn: 是否按国内网络处理,
  verified: 这个版本有没有钉死的 sha256,
  sha256: "实际算出的 sha256",
  ready: 桥 + 库是否都就绪
}
```

细节：

- 下载成功且设置里的 `tutkLibPath` 为空时，模块会把 `result.path` 写回设置，抓帧时就能找到；
- `verified: false` 不是失败：当前 `KNOWN_LIB_SHA256` 里只有 `v2.3.0`，而且两个哈希都还是空串；表里没有的版本也不校验。面板要如实提示「这次没有校验和」，不能说「已校验」；
- `ready` = `checkBridgeBinary(bridgePath, { libPath: result.path })` 的 `ok && libOk`；桥缺失时下载成功也会是 `false`。

**会被拒绝**：

- 没读到主人 QQ → `NO_OWNER`；
- 主人还没账号/解不开 → `LOCKED`；
- 目录解析不出来 → `NO_DIR`；
- 平台不支持自动下载 → `UNSUPPORTED_PLATFORM`；
- 下载包/解压后超过 320MB → `TOO_LARGE`；
- 所有下载源都失败 → `ALL_SOURCES_FAILED`；
- 下载源响应不合法 → `PROTOCOL`；
- 解压/找文件失败 → `EXTRACT_FAILED`；
- 钉死的 sha256 对不上 → `LIB_SHA256_MISMATCH`。

### POST /tutk/mint

**什么时候调**：外部调用/测试；当前面板不调。它只验证「这个账号/这台打印机能不能拿到云画面凭据」，不抓帧。

**参数**：`{ qq, selector? }`。

**谁能调**：没有调用者校验；`qq` 必须有账号且能被解开（`isUsableNow`），否则 `LOCKED`。

**成功返回**：`{ ok: true, message: "云端已发放 TUTK 凭据，这台打印机支持云画面。", printer: { name, serialMasked } }`。

**会被拒绝**：

- 没账号/解不开 → `LOCKED`；
- 没有云端绑定的打印机 → `NO_CLOUD`；
- 有云端绑定但没 token → `NO_TOKEN`；
- 铸码失败 → 透传 `mintTutcode` 的码（`TIMEOUT`、`NETWORK`、`HTTP`、`BAD_JSON`、`NO_UID`、`NO_SECRETS`、`BAD_RESPONSE` 等）；
- 多台云端打印机没选 → `{ ok: true, needChoice: true, choices }`。

**注意**：`pickPrinter` 返回 `NO_PRINTER` 或 `AMBIGUOUS` 时，这条路由也会统一翻成 `NO_CLOUD`，message 仍然是「这个用户没有云端绑定的打印机」。这是代码现状，不是文档写错。

---

## 审计

### GET /audit?limit=50

**什么时候调**：面板「审计」页。

**参数**：`limit` 默认 50，夹在 1~200。

**谁能调**：没有调用者校验。

**成功返回**：`{ ok: true, audit: [ { at, actor, actorMasked, action, ok, note } ] }`。

- `at` 是毫秒时间戳；
- `actor` 是完整 QQ，`actorMasked` 是打码值；
- 新的在前；
- 里面包含接口和聊天命令写下的记录（解锁、绑定、控制、授权、下载、发现、证书固定等）；
- 不包含任何 token / 访问码 / 密码。`note` 最长 160 字，换行会被压掉。

**会被拒绝**：保险箱读失败会抛错。

---

## 锁定后会发生什么

`/owner/lock` 或 `/lock` 只是清掉内存里的解密会话，不是「封号」。但不同路由反应不一样：

- 命令入口、选打印机的回复、模型工具都会在下次执行前自动补会话（`ensureSession`，所有账号一样）；
- `/owner/unlock`、`/unlock`、`/owner/nocode`、`/login`、`/tutk/mint`、`/tutk/download` 会主动解；
- `/bind` 里的 `addBinding` 会自动补会话，所以锁着也能绑；
- `/unbind` 不会自动补会话，锁着时返回 `LOCKED`；
- `/interface`、`/groupperm`、`/grant` 直接要求当前有会话，锁着时返回/抛出 `LOCKED`；
- `/logout` 锁着时每条删除都会失败并被忽略，可能返回 `ok:true` 但 `removed:0`；
- `/status`、`/control` 可能因为拿不到明文秘密而报 `NO_CLOUD` / `NO_LAN`，不一定是 `LOCKED`；
- `/photo` 在需要取 token 时会报 `LOCKED`。

所以排查「刚点过锁定，面板怎么报错了」时，先让对应账号再解锁一次（或发一条命令），不要以为是权限坏了。

---

## 错误码怎么读

下面只列路由层常见码。打印机、云端登录、TUTK 下载还会透传自己的底层码，别把这张表当完整枚举。

| 错误码 | 从哪来 | 人话 |
|---|---|---|
| `BAD_INPUT` | 各处参数校验 | 参数不对，看 message 里的具体字段 |
| `NO_USER` | 保险箱 | 这个 QQ 还没有账号/绑定 |
| `NO_OWNER` | 主人路由 | 配置里没读到主人 QQ |
| `LOCKED` | 保险箱/会话 | 内存里没有解密会话，或账号不存在 |
| `NOT_FOUND` | 保险箱 | 找不到绑定/授权/可授权项 |
| `FORBIDDEN` | 授权 | 既不是授权人也不是被授权人 |
| `NO_PRINTER` | 选择打印机 | 没有绑定，或 selector 找不到 |
| `NEED_CHOICE` | 选择打印机 | 有多台，等用户选（通常包在 `ok:true` 里） |
| `AMBIGUOUS` | 选择打印机 | selector 命中多台，说得更具体些 |
| `NEED_CONFIRM` | 停止/退出账号 | 需要再确认一次 |
| `NO_CLOUD` | 接口选择/铸码 | 没有云端凭据或没有云端绑定 |
| `NO_LAN` | 接口选择/拍照 | 没有局域网地址+访问码，或局域网这条路失败 |
| `CLOUD_ONLY` | 接口选择 | 非主人只能用云端 |
| `OFFLINE` | 打印机连接 | 连不上/没拿到状态 |
| `CERT_UNPINNED` | 局域网 MQTT | 没固定证书，拒绝发访问码 |
| `CERT_CHANGED` | 局域网 MQTT | 证书和上次固定不一致 |
| `CAMERA_UNPINNED` | 局域网拍照 | 摄像头证书没固定，拒绝抓拍 |
| `RTSPS_UNPINNED` / `RTSPS_CERT_UNPINNED` | RTSPS 拍照 | :322 没 pin，不启动 ffmpeg |
| `RTSPS_CERT_MISMATCH` | RTSPS 拍照 | :322 证书和固定值不一致 |
| `NO_TUTK_TOOL` | 云端拍照 | 没有可用的抓帧桥 |
| `NO_BAMBUSOURCE` | 云端拍照 | 缺 BambuSource 库 |
| `BRIDGE_FAILED` / `BRIDGE_HASH_MISMATCH` / `BRIDGE_UNREADABLE` | 云端拍照 | 桥启动失败/哈希不对/读不了 |
| `TIMEOUT` | 云端拍照/登录 | 等超时 |
| `EMPTY_DUMP` | 云端拍照 | 桥没拿到画面（云画面没开/ttcode 过期/库版本不对） |
| `NO_FFMPEG` / `FFMPEG_FAILED` | H.264 拍照 | X1/H2/P2S/X2D 需要本机 ffmpeg |
| `TOO_LARGE` | 下载/桥输出 | 超过大小上限 |
| `ALL_SOURCES_FAILED` | 下载 | 直连和代理都失败 |
| `EXTRACT_FAILED` / `PROTOCOL` / `LIB_SHA256_MISMATCH` | 下载 | 解压失败/响应不合法/哈希不对 |
| `NOT_READY` | 登录信封 | 数据目录不可写，私钥没就绪 |
| `BAD_FORMAT` / `BAD_VERSION` / `BAD_SUITE` / `BAD_TAG` / `BAD_PAYLOAD` | 登录信封 | 信封不是本模块的/版本不支持/解不开/内容不对 |
| `EXPIRED` / `NOT_YET` / `REPLAYED` | 登录信封 | 过期/时间还没到/已经用过 |
| `DISCOVERY_FAILED` | 局域网发现 | 搜索失败 |

---

## 改文档时怎么对代码

- 路由注册：`index.mjs` 的 `setup()`，从 `api.route('/overview')` 开始；
- 响应字段以每个 `return` 为准，不要按老文档猜；
- 打码：`lib/policy.mjs` 的 `maskQQ` / `maskIp`、`index.mjs` 的 `maskSerial`、`lib/crypto.mjs` 的 `maskSecret`；
- 错误文案：`index.mjs` 的 `explain()` 和各个路由 catch；
- 设置默认值/范围：`lib/settings.mjs` 的 `SETTING_RULES`；
- 面板实际调用：`panel.js` 里的 `request('/…')`。

只要这三处（路由、保险箱、设置表）有一处改了，这份文件就要跟着改。
