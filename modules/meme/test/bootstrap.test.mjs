import { fileURLToPath } from 'node:url';
import { extractResourceArchive } from '../scripts/resource-archive.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, mkdir, writeFile, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer } from 'node:http';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { BootstrapManager } from '../lib/bootstrap.mjs';
import { hasBaseRuntime, chooseRuntimeDir } from '../scripts/runtime-state.mjs';
import { prepareDependencies } from '../scripts/prepare-runtime.mjs';
import { withRuntimeLock } from '../scripts/bootstrap.mjs';
import { seedRuntimeMetadata } from './helpers/runtime.mjs';
const log={warn(){}};
test('首次准备自动完成、真实阶段进度、同时点击只启动一次；已完成不触发重装',async()=>{
 let release,started=0,loaded=0;
 const wait=new Promise(r=>release=r);
 const b=new BootstrapManager({dir:tmpdir(),runtimeDir:tmpdir(),log,onReady:async()=>loaded++,prepare:async progress=>{started++;progress({phase:'components',message:'正在准备运行组件…',completed:1,total:3});await wait;}});
 b.start();b.start();assert.equal(started,1);assert.equal(b.status().completed,1);assert.equal(b.status().busy,true);
 release();await b.task;assert.equal(loaded,1);assert.equal(b.status().phase,'ready');assert.equal(b.status().busy,false);b.start();assert.equal(started,1);b.dispose();
});
test('失败可重试，错误与私有路径仅进入日志；停止后不回写或加载',async()=>{
 let fail=true,loaded=0;const logs=[];
 const b=new BootstrapManager({log:{warn:(...x)=>logs.push(x.join(' '))},onReady:async()=>loaded++,prepare:async()=>{if(fail)throw Error('C:\\private\\token=secret');}});
 b.start();await b.task;assert.match(b.status().error,/重试/);assert.doesNotMatch(JSON.stringify(b.status()),/private|secret/);assert.match(logs[0],/private/);
 fail=false;b.start();await b.task;assert.equal(loaded,1);b.dispose();
 let release;const waiting=new Promise(r=>release=r);
 const stopped=new BootstrapManager({log,onReady:async()=>loaded++,prepare:()=>waiting});stopped.start();stopped.dispose();release();await stopped.task;assert.equal(loaded,1);
});
test('现有完整离线安装复用原路径；轻量新安装选择持久缓存；残缺文件不算就绪',async()=>{
 const dir=await mkdtemp(join(tmpdir(),'meme-ready-')), cache=join(dir,'cache');
 try{
  assert.equal(chooseRuntimeDir(dir,cache),cache);assert.equal(hasBaseRuntime(dir),false);
  await seedRuntimeMetadata(dir);assert.equal(chooseRuntimeDir(dir,cache),dir);assert.equal(hasBaseRuntime(dir),true);
  await rm(join(dir,'node_modules','.meme-runtime','fixture.bin'));assert.equal(hasBaseRuntime(dir),false);
 }finally{await rm(dir,{recursive:true,force:true});}
});
test('运行目录锁串行化两个写入者，完成后可再次准备',async()=>{
 const dir=await mkdtemp(join(tmpdir(),'meme-lock-'));let entered=0,release;
 try{
  const waiting=new Promise(r=>release=r);
  const first=withRuntimeLock(dir,async()=>{entered++;await waiting;});
  while(!entered)await new Promise(r=>setTimeout(r,10));
  const second=withRuntimeLock(dir,async()=>entered++);await new Promise(r=>setTimeout(r,30));assert.equal(entered,1);
  release();await Promise.all([first,second]);assert.equal(entered,2);
 }finally{await rm(dir,{recursive:true,force:true});}
});
test('Windows 安装子流程：下载→锁定完整性校验→解包；重试复用，校验失败不执行',async()=>{
 const dir=await mkdtemp(join(tmpdir(),'meme install 空间-'));const content=join(dir,'source','package');let requests=0;
 await mkdir(content,{recursive:true});await writeFile(join(content,'package.json'),JSON.stringify({version:'1.0.0'}));await writeFile(join(content,'index.js'),'export default 1;');
 const archive=join(dir,'fixture.tgz');execFileSync('tar',['-czf',archive,'-C',join(dir,'source'),'package']);const bytes=await readFile(archive);
 const server=createServer((req,res)=>{requests++;res.end(bytes);});await new Promise(r=>server.listen(0,'127.0.0.1',r));
 const pkg={name:'@fixture/test',version:'1.0.0',required:['index.js'],url:`http://127.0.0.1:${server.address().port}/fixture.tgz`,integrity:'sha512-'+createHash('sha512').update(bytes).digest('base64')};
 try{
  const target=join(dir,'runtime');await prepareDependencies(target,{packages:[pkg]});assert.equal(requests,1);
  await prepareDependencies(target,{packages:[pkg]});assert.equal(requests,1);
  await prepareDependencies(join(dir,'offline'),{packages:[pkg],sourceRoot:target});assert.equal(requests,1);
  await assert.rejects(prepareDependencies(join(dir,'bad'),{packages:[{...pkg,integrity:'sha512-wrong'}]}),/校验失败/);
  assert.equal(await readFile(join(target,'node_modules','@fixture','test','index.js'),'utf8'),'export default 1;');
 }finally{await new Promise(r=>server.close(r));await rm(dir,{recursive:true,force:true});}
});

test('素材按整库归档获取：一次请求获取素材目录，支持中文路径',async()=>{
 const dir=await mkdtemp(join(tmpdir(),'meme-archive-'));const original=join(dir,'source','repo-revision');
 let requests=0;
 await mkdir(join(original,'resources','中文'),{recursive:true});
 await writeFile(join(original,'resources','中文','A B.png'),'first');
 await writeFile(join(original,'resources','second.png'),'second');
 await writeFile(join(original,'ignored.txt'),'not extracted');
 const bytes=await readFile(new URL('./fixtures/resources-utf8.tar.gz',import.meta.url));
 const server=createServer((req,res)=>{requests++;res.end(bytes);});await new Promise(r=>server.listen(0,'127.0.0.1',r));
 try {
  const home=join(dir,'runtime');await extractResourceArchive(home,{archiveRoot:'repo-revision',archiveUrl:`http://127.0.0.1:${server.address().port}/archive`,files:[{path:'resources/中文/A B.png',size:5},{path:'resources/second.png',size:6}]});
  assert.equal(requests,1);assert.equal(await readFile(join(home,'resources','中文','A B.png'),'utf8'),'first');
  await assert.rejects(readFile(join(home,'ignored.txt')),/ENOENT/);
  await assert.rejects(readFile(join(home,'.archive-files.txt')),/ENOENT/);
 }finally{await new Promise(r=>server.close(r));await rm(dir,{recursive:true,force:true});}
});
test('持久缓存安装仍可打成单目录离线包，无需复制一套大资源',async()=>{
 const dir=await mkdtemp(join(tmpdir(),'meme-pack-test-')),root=join(dir,'modules','meme'),runtime=join(dir,'modules-data','meme','runtime');
 try {
  await mkdir(root,{recursive:true});await writeFile(join(root,'index.mjs'),'export default {};');
  await seedRuntimeMetadata(runtime);const out=join(dir,'offline.tar.gz');
  execFileSync(process.execPath,[fileURLToPath(new URL('../scripts/pack.mjs',import.meta.url)),root,out],{stdio:'pipe'});
  const list=execFileSync('tar',['-tzf',out],{encoding:'utf8'});
  assert.match(list,/meme\/index.mjs/);assert.match(list,/meme\/node_modules\/\.meme-runtime\/ready.json/);
  assert.equal(hasBaseRuntime(runtime),true);
 }finally{await rm(dir,{recursive:true,force:true});}
});
