import { checkEnvironment } from '../lib/environment.mjs';
import { preparePythonRuntime } from './prepare-python-runtime.mjs';
import { withRuntimeLock } from './bootstrap.mjs';
import { cachedExtension } from '../lib/extension.mjs';
import { extractResourceArchive, validResource } from './resource-archive.mjs';
import { prepareSkiaData } from './python-data.mjs';
import { readFile, writeFile, stat, mkdir, rm, rename, readdir, unlink } from 'node:fs/promises';
import { join, dirname, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn, execFile } from 'node:child_process';
import { promisify } from 'node:util';
const run = promisify(execFile);
const execute = (file, args, options={}) => new Promise((res,rej)=>{const p=spawn(file,args,{stdio:'inherit',windowsHide:true,...options});p.on('error',rej);p.on('exit',code=>code===0?res():rej(Error(`${file} 退出 ${code}`)));});
const exists = p => stat(p).then(()=>true,()=>false);
export async function preparePython(root,{onProgress=()=>{}}={}) {
 await checkEnvironment({extension:true,download:!cachedExtension(root)});
 return withRuntimeLock(root, () => preparePythonFiles(root, onProgress), '.extension-install.lock');
}
async function preparePythonFiles(root,onProgress) {
 const manifest=JSON.parse(await readFile(new URL('./python-pack.json',import.meta.url),'utf8'));
 const home=join(root,'node_modules','.meme-python'), source=join(home,'source'), toolDir=join(home,'tools');
 await mkdir(source,{recursive:true});await mkdir(toolDir,{recursive:true});
 const marker=join(home,'ready.json');
 if(cachedExtension(root)) {await prepareSkiaData(home, `${process.platform}-${process.arch}`);console.log('Python 扩展已准备');return;}
 const missing=[];
 for(const f of manifest.files)if(!await validResource(source,f))missing.push(f);
 if(missing.length) {
  onProgress({message:'正在下载扩展素材…'});
  console.log(`下载扩展素材包，补齐 ${missing.length} 个文件`);
  const suffixes=['png','jpg','jpeg','gif','webp','bmp','ttf','otf','mp4'];
  const excludePatterns=manifest.excludedKeys.flatMap(key=>suffixes.map(ext=>`*/memes*/${key}/*.${ext}`));
  await extractResourceArchive(source,{repository:manifest.repository,revision:manifest.revision,files:missing,excludePatterns,onBytes:received=>onProgress({message:'正在下载扩展素材…',received})});
 }
 onProgress({message:'正在准备扩展组件…'});
 const {uv,executable}=await preparePythonRuntime(home);
 const env={...process.env,UV_CACHE_DIR:join(toolDir,'cache'),UV_NO_CACHE:'1',UV_PYTHON:executable,UV_PYTHON_DOWNLOADS:'never'};
 const requirements=join(home,'requirements.txt');
 await run(uv,['export','--frozen','--no-dev','--no-emit-project','--no-hashes','--format','requirements-txt','--output-file',requirements],{cwd:source,env,windowsHide:true});
 await execute(uv,['pip','install','--python',executable,'--target',join(home,'site-packages'),'--only-binary',':all:','--index-url','https://pypi.org/simple','-r',requirements],{env});
 onProgress({message:'正在载入扩展模板…'});
 await prepareSkiaData(home, `${process.platform}-${process.arch}`);
 await writeFile(join(home,'excluded.json'),JSON.stringify(manifest.excludedKeys));
 const runtime={platform:`${process.platform}-${process.arch}`,revision:manifest.revision,executable:relative(home,executable),excluded:manifest.excludedKeys.length};
 await writeFile(join(home,'runtime.json'),JSON.stringify(runtime));
 await execute(executable,['-u',fileURLToPath(new URL('../lib/python-worker.py',import.meta.url)),'--catalog'],{env:{...env,MEME_PYTHON_HOME:home,MEME_MODULE_DIR:root,MEME_HOME:join(root,'node_modules','.meme-runtime'),PYTHONUTF8:'1',PYTHONDONTWRITEBYTECODE:'1'}});
 const catalog=JSON.parse(await readFile(join(home,'catalog.json'),'utf8'));
 runtime.count=catalog.length;
 // The upstream loader has already resolved same-ID entries. Keep one set of assets.
 const active=new Set(JSON.parse(await readFile(join(home,'active-directories.json'),'utf8'))), skipped=[];
 const trim=async dir=>{for(const entry of await readdir(dir,{withFileTypes:true})){const p=join(dir,entry.name);if(entry.isDirectory())await trim(p);else if(!/\.py$|LICENSE|NOTICE/i.test(entry.name))await rm(p,{force:true});}};
 const packageDir=join(source,'meme_generator');
 for(const family of await readdir(packageDir,{withFileTypes:true}))if(family.isDirectory()&&family.name.startsWith('memes')) {
  for(const entry of await readdir(join(packageDir,family.name),{withFileTypes:true}))if(entry.isDirectory()) {
   const key=family.name+'/'+entry.name;
   if(!active.has(key)){skipped.push(key);await trim(join(packageDir,family.name,entry.name));}
  }
 }
 await writeFile(join(home,'skipped-directories.json'),JSON.stringify(skipped));
 await writeFile(marker+'.part',JSON.stringify(runtime));await rename(marker+'.part',marker);
 // Keep installed files, not installer caches or archives.
 await rm(toolDir,{recursive:true,force:true});
 for(const entry of await readdir(join(home,'interpreter'),{withFileTypes:true}))if(entry.isSymbolicLink())await unlink(join(home,'interpreter',entry.name));
 console.log(`Python 扩展就绪：新增 ${catalog.length} 个模板`);
}
if(process.argv[1]&&resolve(process.argv[1])===fileURLToPath(import.meta.url))await preparePython(resolve(process.argv[2]||fileURLToPath(new URL('..',import.meta.url))),{onProgress:state=>console.log('@@MEME_EXTENSION '+JSON.stringify(state))});
