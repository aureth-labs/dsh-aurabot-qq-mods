/**
 * roost 启动守护
 * =============
 * 由 lib/roost.mjs 的 startRoost() 拉起，再真实启动模块自带的 roost。
 *
 * 为什么不在模块 dispose() 里关 roost：Aurabot 热重载也会调 dispose()
 * （core/modules.js:749），那不是 DSH 退出。改成盯宿主进程：
 * 只要启动它的那个进程还在，roost 就不动；进程真没了（正常关闭或崩溃），
 * 这里负责把 roost 一起收掉，避免留下孤儿进程和端口占用。
 */
import { spawn } from 'node:child_process';

const [codeDir = '', homeDir = '', parentPidRaw = '', electronFlagRaw = ''] = process.argv.slice(2);
const parentPid = Number(parentPidRaw) || 0;

const env = { ...process.env };
if (electronFlagRaw === '1') env.ELECTRON_RUN_AS_NODE = '1';
if (homeDir) env.ROOST_HOME = homeDir;

const child = spawn(process.execPath, ['src/main.js', '--serve', '--no-open'], {
  cwd: codeDir || process.cwd(),
  env,
  stdio: ['ignore', 'ignore', 'ignore'],
  windowsHide: true,
});

let killed = false;

/** 父进程还在吗？EPERM 说明进程存在但没权限问，按活着处理。 */
function parentAlive() {
  if (!parentPid) return true;
  try {
    process.kill(parentPid, 0);
    return true;
  } catch (e) {
    return Boolean(e && e.code === 'EPERM');
  }
}

function endChild() {
  if (killed || child.exitCode !== null) return;
  killed = true;
  try { child.kill('SIGTERM'); } catch {}
  const force = setTimeout(() => {
    try { child.kill('SIGKILL'); } catch {}
    process.exit(0);
  }, 3000);
  force.unref?.();
}

const watch = setInterval(() => {
  if (!parentAlive()) {
    clearInterval(watch);
    endChild();
  }
}, 1000);
watch.unref?.();

child.on('exit', () => {
  clearInterval(watch);
  process.exit(0);
});
child.on('error', () => {
  clearInterval(watch);
  process.exit(1);
});
