import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,mkdir,writeFile,readFile,access,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {buildRelease} from '../scripts/build.mjs';
test('市场构建保留首次安装所需源码/清单，不带本机缓存或私密配置',async()=>{
 const root=await mkdtemp(join(tmpdir(),'meme-build-'));
 try{
  await writeFile(join(root,'module.json'),JSON.stringify({version:'1.0.0',build:{out:'.build'}}));
  await writeFile(join(root,'package.json'),JSON.stringify({version:'1.0.0'}));
  for(const name of ['index.mjs','panel.js','README.md','LICENSE','THIRD-PARTY-NOTICES.md'])await writeFile(join(root,name),'fixture');
  for(const name of ['lib','scripts','assets','docs','node_modules','test']){await mkdir(join(root,name));await writeFile(join(root,name,'fixture.json'),'{}');}
  await writeFile(join(root,'.env'),'private');
  const out=await buildRelease(root);
  for(const name of ['index.mjs','scripts/fixture.json','lib/fixture.json','assets/fixture.json'])assert.ok(await readFile(join(out,name),'utf8'));
  for(const name of ['node_modules','test','.env'])await assert.rejects(access(join(out,name)),/ENOENT/);
  assert.match(await readFile(join(out,'RELEASE.md'),'utf8'),/首次运行/);
 }finally{await rm(root,{recursive:true,force:true});}
});
test('市场构建拒绝版本不一致和模块外输出目录',async()=>{
 const root=await mkdtemp(join(tmpdir(),'meme-build-'));
 try{
  await writeFile(join(root,'module.json'),JSON.stringify({version:'1.0.1',build:{out:'.build'}}));await writeFile(join(root,'package.json'),JSON.stringify({version:'1.0.0'}));
  await assert.rejects(buildRelease(root),/版本不一致/);
  await writeFile(join(root,'module.json'),JSON.stringify({version:'1.0.0',build:{out:'../outside'}}));await assert.rejects(buildRelease(root),/模块内/);
 }finally{await rm(root,{recursive:true,force:true});}
});
