/**
 * exec-guard.mjs —— 外部命令的唯一放行口
 *
 * 这个模块是「能跑什么」的唯一真相来源。autonomy 里所有 execFile 都必须先过
 * `checkExec()`，不经过它的调用一律视为缺陷（有回归测试盯着）。
 *
 * 设计原则：
 *   1. **白名单优先**：不在白名单里的组合，直接拒绝，理由写清楚。
 *   2. **危险命令永远拒绝**：即使将来白名单放宽，命中黑名单也一律拒绝——这是兜底，
 *      不是主要防线（主要防线是白名单本身足够窄）。
 *   3. **不接受任意命令文本**：只接受「可执行文件 + 参数数组」，没有 shell 参与，
 *      所以 `;` `&&` `|` `$()` 这些拼接在结构上就无效。
 *   4. **模型给的文本永不进入参数**：调用方必须先经过 `assertNoModelText()`。
 *
 * 现在实际只有两组调用：
 *   - adb  ← 手机操作（子命令字面量）
 *   - node ← 只允许 --check（校验自写模块语法）
 */

/** 危险命令：命中即拒，不看白名单。用正则是因为要挡住各种变形。 */
const DANGEROUS = [
  // 破坏性删除 / 格式化 / 写裸设备
  { re: /\brm\s+(-[a-zA-Z]*[rf][a-zA-Z]*\s+)+/, why: '递归/强制删除' },
  { re: /\bmkfs(\.\w+)?\b/, why: '格式化文件系统' },
  { re: /\bdd\b[^|;]*\bof=\/dev\//, why: '写裸设备' },
  { re: /\b(shred|wipefs)\b/, why: '擦除数据' },
  { re: />\s*\/dev\/(sd|nvme|hd|vd)/, why: '重定向到磁盘设备' },
  // 关机 / 重启 / 杀进程
  { re: /\b(shutdown|reboot|halt|poweroff)\b/, why: '关机或重启' },
  { re: /\binit\s+[06]\b/, why: '切换运行级别' },
  { re: /\bkill\s+-9\s+-1\b|\bkillall5\b/, why: '杀全部进程' },
  // 权限 / 属主
  { re: /\bchmod\s+(-[a-zA-Z]+\s+)*777\s+\//, why: '把根目录改成 777' },
  { re: /\bchmod\s+(-[a-zA-Z]+\s+)*[ugoa]*\+s\b/, why: '设置 setuid/setgid' },
  { re: /\bchown\s+(-[a-zA-Z]+\s+)*[^ ]+\s+\/\s*$/, why: '改根目录属主' },
  // 提权 / 改账户
  { re: /\b(sudo|su|doas)\s/, why: '提权' },
  { re: /\b(useradd|userdel|usermod|groupadd|groupdel|passwd)\b/, why: '改账户' },
  // 管道执行远端内容（经典一键木马）
  { re: /\b(curl|wget|fetch)\b[^|;]*\|\s*(ba|z|d|k)?sh\b/, why: '下载后直接执行' },
  { re: /\|\s*(ba|z|d|k)?sh\s*($|;)/, why: '管道进 shell' },
  { re: /\beval\s+/, why: 'eval 动态执行' },
  // fork 炸弹 / 反弹 shell
  { re: /:\(\)\s*\{.*\}\s*;?\s*:/, why: 'fork 炸弹' },
  { re: /\bnc\b[^|;]*\s-e\s/, why: '反弹 shell' },
  { re: /\/dev\/tcp\//, why: 'bash 直接开网络连接' },
  // 防火墙 / 内核 / 系统配置
  { re: /\b(iptables|nft|ufw|firewall-cmd)\b/, why: '改防火墙' },
  { re: /\b(sysctl|insmod|rmmod|modprobe)\b/, why: '改内核参数或模块' },
  { re: /\bcrontab\s+-r\b/, why: '清空计划任务' },
  // 远端连接（这个版本本就不该出现，兜底一层）
  { re: /\b(ssh|scp|sftp|rsync)\b[^|;]*@/, why: '连远端主机' },
  { re: /\bssh\s+-\w/, why: 'ssh 带参数连接' },
]

/** adb 允许的子命令前缀。第一个词不在表里就拒。 */
const ADB_ALLOWED = [
  ['devices'],
  ['start-server'],
  ['shell', 'dumpsys'], // 读状态：power / deviceidle 等
  ['shell', 'input'], // 模拟操作：keyevent / swipe / text
  ['shell', 'settings'], // 读/写系统设置里的亮度音量这类
  ['shell', 'am'], // 启动 App / 发广播（start -n 包名）
  ['shell', 'pm'], // 查已装应用
  ['shell', 'wm'], // 读屏幕尺寸
  ['shell', 'screencap'], // 截图
  ['shell', 'ls'],
  ['shell', 'cat'],
  ['shell', 'mkdir'],
  ['shell', 'printf'],
  ['shell', 'base64'],
  ['shell', 'date'],
  ['push'],
  ['pull'],
]

/** node 只允许 `--check <文件>`，用来校验她自写模块的语法。 */
const NODE_ALLOWED = [[/^--check$/, /./]]

/**
 * 检查一次外部调用能不能跑。
 * @param {string} file 可执行文件（必须是 'adb' 族或 'node'）
 * @param {string[]} args 参数数组
 * @returns {{ok: boolean, reason?: string}}
 */
export function checkExec(file, args) {
  const exe = String(file || '').trim().toLowerCase();
  const list = (Array.isArray(args) ? args : []).map((a) => String(a ?? ''));
  if (!exe) return { ok: false, reason: '没有可执行文件' };
  if (!Array.isArray(args)) return { ok: false, reason: '参数必须是数组（不拼字符串，避免 shell 参与）' };

  // 危险命令兜底：把所有参数拼起来扫一遍。真实调用不走 shell，这些字符本来也无效，
  // 但命中就意味着调用方在拼命令，属于实现错误，直接拒。
  const joined = list.join(' ');
  for (const { re, why } of DANGEROUS) {
    if (re.test(joined)) return { ok: false, reason: `命中危险命令清单：${why}` }
  }
  // 拼接符号出现即拒：参数里不该有 shell 元字符
  if (/[;&|`$(){}<>\n]/.test(joined)) {
    return { ok: false, reason: '参数里有 shell 元字符，拒绝拼命令' }
  }

  const isAdb = /(^|[\\/])adb(\.exe)?$/.test(exe);
  const isNode = /(^|[\\/])node(\.exe)?$/.test(exe);

  if (isAdb) {
    const ok = ADB_ALLOWED.some((prefix) => prefix.every((word, i) => list[i] === word));
    return ok ? { ok: true } : { ok: false, reason: `adb 子命令不在白名单：${list.slice(0, 2).join(' ') || '(空)'}` }
  }
  if (isNode) {
    const ok = NODE_ALLOWED.some((pattern) => pattern.every((re, i) => re.test(list[i] ?? '')));
    return ok ? { ok: true } : { ok: false, reason: `node 只允许 --check，收到：${list[0] || '(空)'}` }
  }
  return { ok: false, reason: `可执行文件不在白名单：${exe}` }
}

/**
 * 模型给的文本绝对不能进命令参数。
 * 调用方在把 `detail` / `steps` / `action` 之类交给外部程序之前必须调它——
 * 命中就抛，让 bug 当场暴露，而不是悄悄跑出去。
 */
export function assertNoModelText(args, modelFields) {
  const list = (Array.isArray(args) ? args : []).map((a) => String(a ?? ''));
  const bad = []
  for (const [name, value] of Object.entries(modelFields || {})) {
    const v = String(value ?? '').trim()
    if (!v) continue
    if (list.some((a) => a.includes(v))) bad.push(name)
  }
  if (bad.length) throw new Error(`命令参数里出现了模型给的字段：${bad.join('、')}`)
  return true
}

/** 只给测试和文档用：导出清单本身，方便断言「表里确实有这些条目」 */
export const DANGEROUS_PATTERNS = DANGEROUS.map((d) => d.re.source)
export const ADB_ALLOWED_PREFIXES = ADB_ALLOWED.map((p) => p.join(' '))
