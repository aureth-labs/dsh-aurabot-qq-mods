import { mkdir, open, readFile, rm } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { prepareDependencies } from './prepare-runtime.mjs';
import { prepare } from './prepare.mjs';
import { hasBaseRuntime } from './runtime-state.mjs';
const sleep = ms=>new Promise(r=>setTimeout(r,ms));
// Hot reload can briefly overlap a terminating installer. Only one writer owns a
// runtime directory; a killed install leaves files for the next attempt to reuse.
export async function withRuntimeLock(root, work) {
  await mkdir(root,{recursive:true});const lock=join(root,'.base-install.lock');let owned=false;
  for (let n=0;n<60;n++) {
    try {const file=await open(lock,'wx');await file.writeFile(String(process.pid));await file.close();owned=true;break;}
    catch(e) {
      if(e.code!=='EEXIST')throw e;
      const pid=Number(await readFile(lock,'utf8').catch(()=>''));let alive=true;
      if (pid>0) {try{process.kill(pid,0);}catch(error){if(error.code==='ESRCH')alive=false;}}
      else if (n>3) alive=false;
      if(!alive)await rm(lock,{force:true});else await sleep(500);
    }
  }
  if(!owned)throw new Error('已有准备进程正在运行，请稍后重试');
  try {return await work();} finally {await rm(lock,{force:true});}
}
export async function bootstrap(root,onProgress=()=>{}) {
  return withRuntimeLock(root,async()=>{
    if(hasBaseRuntime(root))return;
    await prepareDependencies(root,{onProgress,sourceRoot:fileURLToPath(new URL('..',import.meta.url))});
    await prepare(root,{onProgress});
    if(!hasBaseRuntime(root))throw new Error('基础库准备后检查未通过');
  });
}
if(process.argv[1]&&resolve(process.argv[1])===fileURLToPath(import.meta.url)) {
  const root=resolve(process.argv[2]||fileURLToPath(new URL('..',import.meta.url)));
  await bootstrap(root,progress=>console.log('@@MEME_INSTALL '+JSON.stringify(progress)));
}
