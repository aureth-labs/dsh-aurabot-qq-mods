import {readFile,stat,rm} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
const run=promisify(execFile);
export async function artifactValid(file,asset) {
  try {return (await stat(file)).size===asset.size && createHash('sha256').update(await readFile(file)).digest('hex')===asset.sha256;}catch{return false;}
}
// Pinned executable artifacts only. The optional API endpoint serves one release
// asset, never one request per template/image. No GitHub login is required.
export async function downloadArtifact(asset,file) {
  if(await artifactValid(file,asset))return;
  const sources=[...(asset.apiUrl?[{url:asset.apiUrl,api:true}]:[]),{url:asset.url}];let last;
  for(const source of sources) {
    try {
      await run(process.platform==='win32'?'curl.exe':'curl',['-fLsS','--connect-timeout','15','--max-time','300',...(source.api?['-H','Accept: application/octet-stream']:[]),'-o',file,source.url],{windowsHide:true});
      if(!await artifactValid(file,asset))throw Error('运行组件完整性检查失败');
      return;
    }catch(e){last=e;await rm(file,{force:true});}
  }
  throw last;
}
