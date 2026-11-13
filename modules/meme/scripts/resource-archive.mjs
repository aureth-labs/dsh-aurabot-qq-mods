import { mkdir, writeFile, rm, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { spawn } from 'node:child_process';
const curl=process.platform==='win32'?'curl.exe':'curl';
export const validResource=(home,f)=>stat(join(home,f.path)).then(s=>s.isFile()&&s.size===f.size,()=>false);
// A single pinned archive per library. Select source/resource directories, not
// individual filenames: Windows tar reads -T using the local code page. The
// ASCII directory selectors also preserve UTF-8 archive names correctly.
// No per-image HTTP/API requests, Git history or archive copy.
export async function extractResourceArchive(home,{repository,revision,archiveRoot,archiveUrl,files,excludePatterns=[],onBytes=()=>{}}) {
  if(!files.length)return;
  await mkdir(home,{recursive:true});
  const root=archiveRoot || `${repository.split('/')[1]}-${revision}`;
  const list=join(home,'.archive-files.txt'),exclusions=join(home,'.archive-excludes.txt');
  const paths=[...new Set(files.map(f=>f.path.split('/')[0]))];
  await writeFile(list,paths.map(path=>`${root}/${path}`).join('\n')+'\n','utf8');
  if(excludePatterns.length)await writeFile(exclusions,excludePatterns.join('\n')+'\n','utf8');
  let download,extract;
  try {
    download=spawn(curl,['-fLsS','--connect-timeout','20','--max-time','1200',archiveUrl || `https://codeload.github.com/${repository}/tar.gz/${revision}`],{windowsHide:true,stdio:['ignore','pipe','pipe']});
    extract=spawn('tar',['-xz',...(process.platform==='win32'?['--options','hdrcharset=UTF-8']:[]),'--strip-components=1','-C',home,...(excludePatterns.length?['-X',exclusions]:[]),'-T',list],{windowsHide:true,stdio:['pipe','ignore','pipe']});
    const wait=p=>new Promise((resolve,reject)=>{
      let tail='';p.stderr.on('data',b=>{tail=(tail+b).slice(-1500);});
      p.once('error',reject);p.once('close',code=>code===0?resolve():reject(new Error(`素材包传输/解压失败 (${code}) ${tail}`)));
    });
    let received=0,last=0;
    download.stdout.on('data',chunk=>{received+=chunk.length;if(Date.now()-last>1000){last=Date.now();onBytes(received);}});
    const pending=[wait(download),wait(extract)];
    extract.stdin.on('error',()=>download.kill());download.stdout.pipe(extract.stdin);
    await Promise.all(pending);onBytes(received);
    const missing=[];for(const f of files)if(!await validResource(home,f))missing.push(f.path);
    if(missing.length)throw new Error(`素材包检查未通过：${missing.length} 个文件缺失或不完整`);
  } finally {download?.kill();extract?.kill();await rm(list,{force:true});await rm(exclusions,{force:true});}
}
