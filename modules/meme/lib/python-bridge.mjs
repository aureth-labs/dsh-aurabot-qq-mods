import { spawn } from 'node:child_process';
import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createInterface } from 'node:readline';
import { userErrorForCode } from './errors.mjs';
export class PythonBridge {
  constructor(dir, runtimeDir = dir) {
    this.dir=dir; this.home=join(runtimeDir,'node_modules','.meme-python');this.child=null;this.pending=new Map();this.seq=0;this.closed=false;
    const marker=join(this.home,'ready.json');
    this.runtime=existsSync(marker)?JSON.parse(readFileSync(marker,'utf8')):null;
    this.items=this.runtime?JSON.parse(readFileSync(join(this.home,'catalog.json'),'utf8')):[];
  }
  spawnWorker(file,args,options) { return spawn(file,args,options); }
  start() {
    if(this.closed)throw Error('模块已停止');
    if(this.child)return;
    if(!this.runtime)throw Error('扩展模板尚未安装完整');
    const child=this.spawnWorker(join(this.home,this.runtime.executable),['-u',fileURLToPath(new URL('./python-worker.py',import.meta.url))],{
      windowsHide:true,stdio:['pipe','pipe','pipe'],env:{...process.env,MEME_PYTHON_HOME:this.home,MEME_MODULE_DIR:this.dir,PYTHONUTF8:'1',PYTHONDONTWRITEBYTECODE:'1',OMP_NUM_THREADS:'1',OPENBLAS_NUM_THREADS:'1'}
    });this.child=child;
    let errors='';child.stderr.on('data',b=>{errors=(errors+b).slice(-1800);});
    const fail=error=>{if(this.child!==child)return;this.child=null;child.kill();for(const pending of this.pending.values())pending.reject(error);this.pending.clear();};
    child.on('error',fail);child.on('exit',code=>fail(Error(`扩展生成进程退出 (${code}) ${errors}`)));
    child.stdin.on('error',fail);
    const lines=createInterface({input:child.stdout});
    lines.on('line',line=>{
      let reply;try{reply=JSON.parse(line);}catch{return;}
      const pending=this.pending.get(reply.id);if(!pending)return;this.pending.delete(reply.id);
      reply.error?pending.reject(userErrorForCode(reply.errorCode) || Error(reply.error)):pending.resolve(Buffer.from(reply.base64,'base64'));
    });
  }
  call(request) {
    this.start();const id=++this.seq;
    return new Promise((resolve,reject)=>{this.pending.set(id,{resolve,reject});this.child.stdin.write(JSON.stringify({...request,id})+'\n',error=>{if(error){this.pending.delete(id);reject(error);}});});
  }
  dispose() {
    this.closed=true;
    const child=this.child; this.child=null;
    for(const p of this.pending.values())p.reject(Error('模块已停止')); this.pending.clear();
    if(!child || child.exitCode !== null) return Promise.resolve();
    return new Promise(resolve=>{child.once('exit',resolve);child.kill();});
  }
}
