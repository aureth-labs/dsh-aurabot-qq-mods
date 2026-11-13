import { UserError } from './errors.mjs';
import { fork } from 'node:child_process';
import { join } from 'node:path';
import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { stopProcessTree as stopWorker } from './process.mjs';
export class Engine {
  constructor(dir, { timeout = 45000, maxQueue = 6, extensionEnabled = true, runtimeDir = dir } = {}) {
    this.dir = dir; this.runtimeDir = runtimeDir; this.extensionEnabled = extensionEnabled; this.timeout = timeout; this.maxQueue = maxQueue;
    this.queue = []; this.seq = 0; this.child = null; this.active = null; this.closed = false;
  }
  start() {
    if (this.child) return;
    const home = join(this.runtimeDir, 'node_modules', '.meme-runtime');
    const ready = join(home, 'ready.json');
    if (!existsSync(ready)) throw new Error('离线资源未安装完整，请运行安装脚本 scripts/install.mjs；不要只复制入口文件');
    const inventory = JSON.parse(readFileSync(ready, 'utf8'));
    if (inventory.version !== '0.2.3' || !inventory.files?.length) throw new Error('离线资源版本不匹配，请重新安装');
    for (const file of inventory.files) if (!existsSync(join(home, file.path))) throw new Error(`缺少离线资源：${file.path}，请重新安装`);
    const child = fork(fileURLToPath(new URL('./worker.mjs', import.meta.url)), [], {
      execArgv: [], windowsHide: true, detached: process.platform !== 'win32', serialization: 'json',
      env: { ...process.env, MEME_RUNTIME_DIR: this.runtimeDir, MEME_EXTENSION_ENABLED: this.extensionEnabled ? '1' : '0', MEME_HOME: home, MEME_MODULE_DIR: this.dir, ELECTRON_RUN_AS_NODE: '1', RAYON_NUM_THREADS: '2' },
      stdio: ['ignore', 'ignore', 'pipe', 'ipc'],
    });
    this.child = child;
    let stderr = '';
    child.stderr.on('data', b => { stderr = (stderr + b).slice(-1500); });
    child.on('message', r => {
      if (this.active?.id !== r.id) return;
      const job = this.active; clearTimeout(job.timer); this.active = null;
      if (!r.error && typeof r.data?.extensionEnabled === 'boolean') this.extensionEnabled = r.data.extensionEnabled;
      r.error ? job.reject(r.publicMessage ? new UserError(r.publicMessage) : new Error(r.error)) : job.resolve(r.data);
      this.pump();
    });
    const failed = error => {
      if (this.child !== child) return;
      this.child = null;
      if (this.active) { clearTimeout(this.active.timer); this.active.reject(error); this.active = null; }
      // Do not repeatedly respawn a broken native binary for every queued request.
      for (const job of this.queue.splice(0)) job.reject(error);
    };
    child.on('error', failed);
    child.on('exit', code => failed(new Error(`本地生成进程已退出 (${code}) ${stderr}`)));
  }
  call(op, args = {}) {
    if (this.closed) return Promise.reject(new UserError('模块已停止'));
    if (this.queue.length + Number(!!this.active) >= this.maxQueue) return Promise.reject(new UserError('表情制作排队已满，请稍后再试'));
    return new Promise((resolve, reject) => { this.queue.push({ id: ++this.seq, op, ...args, resolve, reject }); this.pump(); });
  }
  pump() {
    if (this.active || !this.queue.length || this.closed) return;
    const job = this.queue.shift();
    try { this.start(); } catch (error) { job.reject(error); for (const j of this.queue.splice(0)) j.reject(error); return; }
    this.active = job;
    job.timer = setTimeout(() => {
      if (this.active !== job) return;
      this.active = null; const child = this.child; this.child = null; stopWorker(child);
      job.reject(new UserError('生成超过 45 秒，已取消；请减少图片大小或帧数'));
      this.pump();
    }, this.timeout);
    const { resolve, reject, timer, ...request } = job;
    this.child.send(request, error => { if (error && this.active === job) { clearTimeout(timer); this.active = null; reject(error); stopWorker(this.child); } });
  }
  dispose() {
    this.closed = true;
    if (this.active) { clearTimeout(this.active.timer); this.active.reject(new UserError('模块已停止')); this.active = null; }
    for (const job of this.queue.splice(0)) job.reject(new UserError('模块已停止'));
    stopWorker(this.child); this.child = null;
  }
}
