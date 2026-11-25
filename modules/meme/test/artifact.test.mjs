import test from 'node:test';
import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {mkdtemp,readFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createHash} from 'node:crypto';
import {downloadArtifact} from '../scripts/download-artifact.mjs';
test('固定运行组件使用官方发行 API，校验后复用；错误内容不能作为可执行文件安装',async()=>{
 const bytes=Buffer.from('pinned executable fixture'),dir=await mkdtemp(join(tmpdir(),'meme-artifact-'));let calls=0;
 const server=createServer((req,res)=>{calls++;if(req.url==='/metadata'){res.end('{}');return;}assert.equal(req.headers.accept,'application/octet-stream');res.end(bytes);});
 await new Promise(r=>server.listen(0,'127.0.0.1',r));const base='http://127.0.0.1:'+server.address().port;
 const asset={size:bytes.length,sha256:createHash('sha256').update(bytes).digest('hex'),apiUrl:base+'/asset',url:base+'/metadata'};
 try{
  const file=join(dir,'runtime.zip');await downloadArtifact(asset,file);assert.deepEqual(await readFile(file),bytes);assert.equal(calls,1);
  await downloadArtifact(asset,file);assert.equal(calls,1);
  await assert.rejects(downloadArtifact({...asset,apiUrl:base+'/metadata'},join(dir,'invalid.zip')),/检查失败/);
 }finally{await new Promise(r=>server.close(r));await rm(dir,{recursive:true,force:true});}
});
test('五个平台的扩展组件都有固定版本、来源、大小与完整性值',async()=>{
 const config=JSON.parse(await readFile(new URL('../scripts/python-runtime.json',import.meta.url),'utf8'));
 assert.equal(config.pythonVersion,'3.12.12');assert.equal(config.uvVersion,'0.13.7');
 for(const key of ['win32-x64','darwin-x64','darwin-arm64','linux-x64','linux-arm64']){
  const assets=config.platforms[key];assert.ok(assets.executable);
  for(const asset of [assets.uv,assets.python]){assert.ok(asset.size>0);assert.match(asset.sha256,/^[a-f0-9]{64}$/);assert.match(asset.url,/^https:\/\//);}
 }
});
