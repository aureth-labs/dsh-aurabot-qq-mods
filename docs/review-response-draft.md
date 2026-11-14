# 给 PR #116 安全复审的说明草稿

> 本地草稿，尚未发布。等你确认后再贴到 PR。
> 对应本地提交：`6a008ca`（前一版是 `d826f27`，你上次看到的可能是更早的 `d8fb7be`）

第一件事想先澄清：**你复查时看到的不是最新代码**。

`d8fb7be` 那版确实完整保留了 SSH 链路。`d826f27` 把它整个删掉了。我刚核对过 PR head 上 `modules/autonomy/index.mjs` 的实际内容：

```
ssh       0
runVM     0
vmHost    0
vmPort    0
sshKey    0
VM_DANGER 0
shareDir  0
vmMood    0
```

如果复查时 CI 还没批准运行、diff 又是「autonomy 全新文件 +1278」的形态，很容易看成"还是原来那坨"。建议直接看 head 提交的文件内容。

下面按你提的四点逐条说。

---

## 1) 命令白名单与危险命令回归

**执行面已经撤掉**（SSH 那条通路没了），剩下的外部调用只有两组，现在有显式白名单闸门 `lib/exec-guard.mjs`：

| 可执行 | 允许形态 |
|---|---|
| `adb` | `devices` `start-server` `shell dumpsys/input/settings/am/pm/wm/screencap/ls/cat/mkdir/printf/base64/date` `push` `pull` |
| `node` | 仅 `--check <文件>` |

白名单之外全拒：`shell su`、`shell sh`、`install`、`uninstall`、`root`、`remount`、`forward`，以及任何其他可执行文件（bash/sh/powershell/python/curl/ssh）。

**危险命令清单 27 条**（即使将来放宽白名单也拦）：`rm -rf`、`mkfs`、`dd of=/dev/*`、`shred`、`shutdown/reboot`、`sudo/su`、`useradd/passwd`、`chmod 777 /`、`chmod +s`、`curl|sh`、`wget|bash`、`eval`、`nc -e`、`/dev/tcp/`、`iptables`、`sysctl`、`crontab -r`、`ssh/scp/sftp`。

另两条硬约束：
- **不走 shell**：只传「可执行文件 + 参数数组」，参数里出现 `;&|`$(){}<>` 或换行直接拒
- **模型文本不进参数**：`assertNoModelText()` 钉在 `runAdb` 入口，`detail`/`steps`/`action` 一旦出现在参数里当场拒

回归测试 `test/exec-guard.test.mjs`（11 条）：白名单逐条放行/拒绝、27 条危险命令全拒、元字符拒绝、非数组拒绝、模型文本拒绝、精确前缀（不模糊包含）。

## 2) 只允许主人触发 / 默认关闭 / 超时降级

- **只认主人**：`/自主` 里显式 `api.isOwner(msg.userId)`，非主人拿到空回复、只写拒绝日志、设置不动
- **默认关闭**：`defaults.enabled = false`，装上不会自己动
- **超时真取消**：这个上一版有缺陷——只放了计时器，底层流还在后台挂着。现在改成 `AbortController` 传 `signal` 进 `llm.stream`，超时**真的中止请求**。默认 45 秒，`askTimeoutSec` 可调
- **失败降级**：模型报错/超时/解析失败都只让这一轮歇着，不抛异常

测试 `test/trigger.test.mjs`（7 条），含一个「永不产出但响应 abort」的假流，断言 `aborted === true` 且 `finished === false`——证明是中止而不是空等。

## 3) SSH 凭据保护

SSH 连同 `vmHost`/`vmPort`/`vmUser`/`sshKey`/`shareDir` 一起删了，面板里没有远端主机入口。

剩下一处凭据是手机锁屏密码（`password` 类型）。测试断言：日志里没有、活动流水里没有、数据目录任何文件里都没有。

## 4) CI

本地全绿：

```
npm run catalog  → 写好了 modules/README.md
npm run check    → 23 个模块 ✓（tieba-reader 的 dynamic-code 警告是既有的）
npm run pack     → autonomy-v0.5.0.zip
node --test modules/autonomy/test/*.test.mjs → 36 pass / 0 fail
npm test         → 32 pass / 0 fail
```

但 **PR 上的 checks 一个都没有**，原因是 GitHub 对 fork 来的 PR 默认要求维护者批准才运行工作流——现在 5 次 run 全是 `action_required`，不是失败，是没跑。这一步需要维护者点一次「Approve and run workflows」，我这边无法代劳。

顺带把 `ci.yml` 的 push 触发加上了 `feat/**`，这样贡献者在自己的 fork 上 push 就能先看到结果（frok 的 Actions 需要先在仓库设置里启用）。

---

## 额外收窄了一处

`newmod`（她给自己写模块并热加载）是剩下唯一能让模型**间接影响代码**的入口。现在两道闸：

1. `allowNewMod` 默认 `false`，关着时这个动作直接跳过，不写文件
2. 就算打开，代码还要过 `lib/mod-scan.mjs` 静态扫描：禁起子进程、禁直连网络（含 `fetch`）、禁 `eval`/`new Function`、禁 `api.core`/`api.lib`/`api.dsh`、禁删文件/改权限/改属主、禁系统路径、禁路径穿越

说明白一点：这是降低误伤的门槛，不是沙箱。真正的边界是「默认不给她写」。

---

## 还需要你确认的一点

如果复审认为「命令白名单 + 危险命令清单」仍然不够、要求**完全不保留任何外部调用**，那 `adb` 那组也得拿掉——代价是 `phone` 动作只能调模块接口、不能自己做屏幕状态检查。这个取舍想听你的意见，我不擅自决定。
