import { mkdir, writeFile, rm, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { spawn } from 'node:child_process';
import { curlDownloadArgs, downloadOptionsFromEnv, redactProxy } from './download-options.mjs';
const curl=process.platform==='win32'?'curl.exe':'curl';
export const validResource=(home,f)=>stat(join(home,f.path)).then(s=>s.isFile()&&s.size===f.size,()=>false);
// A single pinned archive per library. Select source/resource directories, not
// individual filenames: Windows tar reads -T using the local code page. The
// ASCII directory selectors also preserve UTF-8 archive names correctly.
// No per-image HTTP/API requests, Git history or archive copy.
export async function extractResourceArchive(home,{repository,revision,archiveRoot,archiveUrl,files,excludePatterns=[],onBytes=()=>{},download:downloadOptions}={}) {
  if(!files.length)return;
  await mkdir(home,{recursive:true});
  const root=archiveRoot || `${repository.split('/')[1]}-${revision}`;
  const list=join(home,'.archive-files.txt'),exclusions=join(home,'.archive-excludes.txt');
  const paths=[...new Set(files.map(f=>f.path.split('/')[0]))];
  await writeFile(list,paths.map(path=>`${root}/${path}`).join('\n')+'\n','utf8');
  if(excludePatterns.length)await writeFile(exclusions,excludePatterns.join('\n')+'\n','utf8');
  // #275：先把压缩包落到临时文件并支持断点续传，下载完整后再解压。
  // --max-time 只限制这一次 curl 请求，不是整包总时长。到点或中断后临时文件还在，下一轮 -C - 续传。
  const options=downloadOptions || downloadOptionsFromEnv();
  const archive=join(home,'.archive-download.tmp');
  const url=archiveUrl || `https://codeload.github.com/${repository}/tar.gz/${revision}`;
  const tailOf=p=>new Promise((resolve,reject)=>{
    let tail='';p.stderr.on('data',b=>{tail=(tail+b).slice(-1500);});
    p.once('error',reject);p.once('close',code=>resolve({code,tail}));
  });
  let extract;
  try {
    let lastError=null;
    for(let attempt=1;attempt<=5;attempt++){
      const existing=await stat(archive).then(s=>s.size).catch(()=>0);
      const args=curlDownloadArgs({
        url,output:archive,timeoutSec:options.timeoutSec,proxy:options.proxy,connectTimeout:20,
        retry:3,retryDelay:2,speedTime:120,speedLimit:1024,resume:existing>0,
      });
      const download=spawn(curl,args,{windowsHide:true,stdio:['ignore','ignore','pipe']});
      // 进度按临时文件大小上报；下载进程退出后再报一次最终值。
      const poll=setInterval(async()=>{try{const s=await stat(archive);onBytes(s.size);}catch{}},1000);
      const {code,tail}=await tailOf(download).catch(error=>{lastError=error;return {code:-1,tail:error.message};});
      clearInterval(poll);
      if(code===0){onBytes(await stat(archive).then(s=>s.size).catch(()=>0));lastError=null;break;}
      lastError=new Error(`素材包下载失败 (${code}) ${redactProxy(tail,options.proxy)}`);
      // 33 = 服务器不支持 Range，删掉重来；其它错误保留已有字节，下一轮续传。
      if(code===33){await rm(archive,{force:true});}
      if(attempt<5)await new Promise(r=>setTimeout(r,1500));
    }
    if(lastError)throw lastError;
    extract=spawn('tar',['-xzf',archive,...(process.platform==='win32'?['--options','hdrcharset=UTF-8']:[]),'--strip-components=1','-C',home,...(excludePatterns.length?['-X',exclusions]:[]),'-T',list],{windowsHide:true,stdio:['ignore','ignore','pipe']});
    const {code,tail}=await tailOf(extract);
    if(code!==0)throw new Error(`素材包解压失败 (${code}) ${redactProxy(tail,options.proxy)}`);
    const missing=[];for(const f of files)if(!await validResource(home,f))missing.push(f.path);
    if(missing.length)throw new Error(`素材包检查未通过：${missing.length} 个文件缺失或不完整`);
  } finally {extract?.kill();await rm(archive,{force:true});await rm(list,{force:true});await rm(exclusions,{force:true});}
}
