import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { ExtensionManager } from '../lib/extension.mjs';
function harness(dir, prepare=async()=>{}) {
  const saved=[], catalog=[], logs=[];
  let enabled=false;
  const engine={call:async(op,args)=>{assert.equal(op,'extension');enabled=args.enabled;return{items:enabled?['base','extra']:['base'],extensionEnabled:enabled,extensionCount:enabled?1:0};}};
  const manager=new ExtensionManager({dir,engine,prepare,check:async()=>{},onCatalog:r=>catalog.push(r.items),save:p=>saved.push(p),log:{warn:(...m)=>logs.push(m.join(' '))}});
  return {manager,saved,catalog,logs};
}
test('安装与卸载同步目录、持久状态，不删除资源；重复操作互斥',async()=>{
  const dir=await mkdtemp(join(tmpdir(),'meme-extension-'));
  const file=join(dir,'retained-resource');await writeFile(file,'keep');
  let release;const prepared=new Promise(r=>release=r);
  const {manager,saved,catalog}=harness(dir,()=>prepared);
  try {
    assert.equal(manager.start(true).busy,true);
    assert.throws(()=>manager.start(false),/正在处理/);
    release();await manager.task;assert.equal(manager.status().installed,true);
    manager.start(false);await manager.task;
    assert.equal(manager.status().installed,false);assert.equal(manager.status().busy,false);
    assert.deepEqual(catalog,[['base','extra'],['base']]);
    assert.deepEqual(saved,[{extensionEnabled:true},{extensionEnabled:false}]);
    assert.equal(await readFile(file,'utf8'),'keep');
    manager.start(true);await manager.task;assert.equal(manager.status().installed,true);
  }finally{manager.dispose();await rm(dir,{recursive:true,force:true});}
});
test('安装失败不改变基础目录与配置，公开提示不含底层诊断，可重试',async()=>{
  let fail=true;const h=harness(tmpdir(),async()=>{if(fail)throw Error('C:\\private\\secret-token');});
  h.manager.start(true);await h.manager.task;
  assert.equal(h.manager.status().installed,false);assert.equal(h.saved.length,0);assert.equal(h.catalog.length,0);
  assert.equal(h.manager.status().error,'安装未完成，请重试。');assert.match(h.logs[0],/secret-token/);
  fail=false;h.manager.start(true);await h.manager.task;assert.equal(h.manager.status().installed,true);h.manager.dispose();
});
test('配置保存失败回滚挂载；模块停止后不继续挂载或保存',async()=>{
  const h=harness(tmpdir());h.manager.save=async()=>{throw Error('save failed')};
  h.manager.start(true);await h.manager.task;assert.equal(h.manager.status().installed,false);
  assert.deepEqual(h.catalog,[['base','extra'],['base']]);
  let release;const waiting=new Promise(r=>release=r);const next=harness(tmpdir(),()=>waiting);
  next.manager.start(true);next.manager.dispose();release();await next.manager.task;
  assert.equal(next.catalog.length,0);assert.equal(next.saved.length,0);h.manager.dispose();
});
test('启动时扩展缺失不影响基础库，保留安全恢复提示',async()=>{
  const h=harness(tmpdir());h.manager.engine.call=async()=>{throw Error('private native failure')};
  await h.manager.restore();assert.equal(h.manager.status().installed,false);
  assert.equal(h.manager.status().error,'扩展库未能加载，请重新安装。');assert.equal(h.saved.length,0);h.manager.dispose();
});
test('停止期间完成的挂载不再回写目录或配置',async()=>{
 const h=harness(tmpdir());let release;h.manager.engine.call=()=>new Promise(r=>release=r);
 h.manager.start(false);h.manager.dispose();release({items:['base'],extensionEnabled:false});await h.manager.task;
 assert.deepEqual(h.catalog,[]);assert.deepEqual(h.saved,[]);
});
test('残缺或旧版扩展标记不视为可直接复用',async()=>{
 const {cachedExtension}=await import('../lib/extension.mjs');const {mkdir}=await import('node:fs/promises');
 const dir=await mkdtemp(join(tmpdir(),'meme-ext-cache-')),home=join(dir,'node_modules','.meme-python');
 try{await mkdir(home,{recursive:true});await writeFile(join(home,'ready.json'),'{partial');assert.equal(cachedExtension(dir),false);
 await writeFile(join(home,'python'),'fixture');await writeFile(join(home,'catalog.json'),'[{}]');await writeFile(join(home,'ready.json'),JSON.stringify({platform:`${process.platform}-${process.arch}`,executable:'python',revision:'old'}));assert.equal(cachedExtension(dir),false);
 }finally{await rm(dir,{recursive:true,force:true});}
});
