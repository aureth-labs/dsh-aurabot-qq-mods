import {readFile,mkdir,rm,rename,access,chmod} from 'node:fs/promises';
import {join} from 'node:path';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {downloadArtifact} from './download-artifact.mjs';
const run=promisify(execFile),exists=p=>access(p).then(()=>true,()=>false);
export async function preparePythonRuntime(home) {
  const manifest=JSON.parse(await readFile(new URL('./python-runtime.json',import.meta.url),'utf8'));
  const platform=`${process.platform}-${process.arch}`,assets=manifest.platforms[platform];if(!assets)throw Error(`扩展不支持 ${platform}`);
  const tools=join(home,'tools'),uvRoot=join(tools,'uv-wheel');await mkdir(tools,{recursive:true});
  const dir=join(home,'interpreter',`cpython-${manifest.pythonVersion}-${platform}`),executable=join(dir,assets.executable);
  if(!await exists(executable)) {
    const archive=join(tools,assets.python.name),stage=dir+'.installing';await downloadArtifact(assets.python,archive);
    await rm(stage,{recursive:true,force:true});await mkdir(stage,{recursive:true});
    try {
      await run('tar',['-xf',archive,'--strip-components=1','-C',stage],{windowsHide:true});
      if(!await exists(join(stage,assets.executable)))throw Error('扩展运行组件解包不完整');
      await rm(dir,{recursive:true,force:true});await rename(stage,dir);
    }finally{await rm(stage,{recursive:true,force:true});await rm(archive,{force:true});}
  }
  const uv=join(uvRoot,`uv-${manifest.uvVersion}.data`,'scripts',process.platform==='win32'?'uv.exe':'uv');
  if(!await exists(uv)) {
    const archive=join(tools,assets.uv.name);await downloadArtifact(assets.uv,archive);await mkdir(uvRoot,{recursive:true});
    // GNU tar does not read ZIP/wheel archives; use the private interpreter.
    if(process.platform==='win32')await run('tar',['-xf',archive,'-C',uvRoot],{windowsHide:true});
    else await run(executable,['-m','zipfile','-e',archive,uvRoot],{windowsHide:true});
    await rm(archive);
    if(!await exists(uv))throw Error('扩展安装组件解包不完整');
    if(process.platform!=='win32')await chmod(uv,0o755);
  }
  return {uv,executable};
}
