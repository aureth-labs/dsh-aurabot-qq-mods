import { spawn } from 'node:child_process';
import { join } from 'node:path';
import { createInterface } from 'node:readline';
import { stopProcessTree } from './process.mjs';
export class BootstrapManager {
  constructor({dir,runtimeDir,onReady,log,prepare}) {
    Object.assign(this,{dir,runtimeDir,onReady,log});
    this.prepare=prepare || (progress=>this.prepareFiles(progress));
    this.state={busy:false,phase:'checking',message:'正在检查表情库…',completed:0,total:0,error:''};this.disposed=false;this.child=null;
  }
  status(){return {...this.state};}
  markReady(){this.state={busy:false,phase:'ready',message:'表情库已就绪',completed:0,total:0,error:''};}
  markFailed(){this.state={busy:false,phase:'failed',message:'表情库未能启动，请重试。',completed:0,total:0,error:'表情库未能启动，请重试。'};}
  start(){
    if(this.disposed || this.state.busy || this.state.phase==='ready')return this.status();
    this.state={busy:true,phase:'checking',message:'正在检查表情库…',completed:0,total:0,error:''};
    this.task=this.run().catch(error=>{
      if(this.disposed)return;
      this.log.warn('基础库准备失败',error.stack || String(error));
      this.state={busy:false,phase:'failed',message:'准备未完成，请稍后重试。',completed:0,total:0,error:'准备未完成，请稍后重试。'};
    });
    return this.status();
  }
  async run(){
    await this.prepare(p=>{if(!this.disposed)this.state={...p,busy:true,error:''};});
    if(this.disposed)return;
    this.state={busy:true,phase:'loading',message:'正在加载表情库…',completed:0,total:0,error:''};
    await this.onReady();
    if(!this.disposed)this.markReady();
  }
  prepareFiles(progress){
    return new Promise((resolve,reject)=>{
      const child=spawn(process.execPath,[join(this.dir,'scripts','bootstrap.mjs'),this.runtimeDir],{
        windowsHide:true,detached:process.platform!=='win32',stdio:['ignore','pipe','pipe'],env:{...process.env,ELECTRON_RUN_AS_NODE:'1'}
      });this.child=child;let tail='';
      child.stderr.on('data',b=>{tail=(tail+b).slice(-4000);});
      const lines=createInterface({input:child.stdout});
      lines.on('line',line=>{
        if(line.startsWith('@@MEME_INSTALL ')){try{progress(JSON.parse(line.slice(15)));}catch{}}
        else tail=(tail+'\n'+line).slice(-4000);
      });
      child.once('error',reject);
      child.once('close',code=>{if(this.child===child)this.child=null;code===0?resolve():reject(new Error(`基础库准备退出 (${code}) ${tail}`));});
    });
  }
  dispose(){this.disposed=true;stopProcessTree(this.child);this.child=null;}
}
