import {readFile,stat,rm} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import {curlDownloadArgs,downloadOptionsFromEnv,runCurl} from './download-options.mjs';
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
      const options=downloadOptionsFromEnv();
      await runCurl(curlDownloadArgs({url:source.url,output:file,timeoutSec:options.timeoutSec,proxy:options.proxy,connectTimeout:15,headers:source.api?['Accept: application/octet-stream']:[]}),{proxy:options.proxy});
      if(!await artifactValid(file,asset))throw Error('运行组件完整性检查失败');
      return;
    }catch(e){last=e;await rm(file,{force:true});}
  }
  throw last;
}
