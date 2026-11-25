import { execFile } from 'node:child_process';
// Only processes created by this module, never the host or another module.
export function stopProcessTree(child) {
  if (!child?.pid) return;
  if (process.platform === 'win32') execFile('taskkill.exe', ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true }, () => {});
  else { try { process.kill(-child.pid, 'SIGKILL'); } catch { child.kill(); } }
}
