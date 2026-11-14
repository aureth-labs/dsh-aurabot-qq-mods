import { existsSync, statSync } from 'node:fs';
import { readFile, mkdir, rm, rename, cp } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { join, dirname } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { runtimePackages, packageReady } from './runtime-state.mjs';
const run = promisify(execFile);
export async function prepareDependencies(root, {onProgress=()=>{}, packages=runtimePackages(), sourceRoot}={}) {
  await mkdir(root,{recursive:true});
  for (let i=0;i<packages.length;i++) {
    const pkg=packages[i], dest=join(root,'node_modules',pkg.name);
    onProgress({phase:'components',message:'正在准备运行组件…',completed:i,total:packages.length});
    if (!packageReady(root,pkg)) {
      const stage=dest+'.installing', archive=dest+'.tgz.part';
      await mkdir(dirname(dest),{recursive:true});await rm(stage,{recursive:true,force:true});await mkdir(stage,{recursive:true});
      try {
        if(sourceRoot && sourceRoot!==root && packageReady(sourceRoot,pkg)) {
          await cp(join(sourceRoot,'node_modules',pkg.name),stage,{recursive:true});
        } else {
        await run(process.platform==='win32'?'curl.exe':'curl',['-fLsS','--retry','2','--connect-timeout','20','--max-time','300','-o',archive,pkg.url],{windowsHide:true});
        // Executable dependencies are pinned to the committed npm lock integrity.
        const [algorithm,expected]=pkg.integrity.split('-');
        if (algorithm!=='sha512' || createHash('sha512').update(await readFile(archive)).digest('base64')!==expected) throw new Error(`依赖校验失败：${pkg.name}`);
        await run('tar',['-xzf',archive,'--strip-components=1','-C',stage],{windowsHide:true});
        }
        if (!packageReadyFromStage(stage,pkg,await readFile(join(stage,'package.json'),'utf8'))) throw new Error(`依赖解包不完整：${pkg.name}`);
        // No active engine uses this incomplete installation during preparation.
        await rm(dest,{recursive:true,force:true});await rename(stage,dest);
      } finally {await rm(archive,{force:true});await rm(stage,{recursive:true,force:true});}
    }
    onProgress({phase:'components',message:'正在准备运行组件…',completed:i+1,total:packages.length});
  }
}
function packageReadyFromStage(stage,pkg,json) {
  return JSON.parse(json).version===pkg.version && pkg.required.every(f=>existsSync(join(stage,f)) && statSync(join(stage,f)).size>0);
}
