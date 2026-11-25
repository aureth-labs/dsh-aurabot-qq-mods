import test from 'node:test';import assert from 'node:assert/strict';
import {EventEmitter} from 'node:events';import {PassThrough} from 'node:stream';
import {mkdtemp,rm} from 'node:fs/promises';import {tmpdir} from 'node:os';import {join} from 'node:path';
import {Engine} from '../lib/engine.mjs';import {seedRuntimeMetadata} from './helpers/runtime.mjs';
async function fixture(options={}){const dir=await mkdtemp(join(tmpdir(),'meme-queue-'));await seedRuntimeMetadata(dir);const engine=new Engine(dir,options),children=[];engine.spawnWorker=env=>{const c=new EventEmitter();c.stderr=new PassThrough();c.sent=[];c.send=(request,callback)=>{c.sent.push(request);c.callback=callback;};c.env=env.env;children.push(c);return c;};return{engine,children,close:async()=>{engine.dispose();await rm(dir,{recursive:true,force:true});}};}
function reply(c,data={},error){c.emit('message',{id:c.sent.at(-1).id,data,...(error?{error,publicMessage:error}:{})});}
test('生成串行、队列有界、单次输入错误后继续处理下一项',async()=>{
 const f=await fixture({maxQueue:2});try{const a=f.engine.call('generate'),b=f.engine.call('generate');await assert.rejects(f.engine.call('generate'),/排队已满/);const c=f.children[0];assert.equal(c.sent.length,1);const bad=assert.rejects(a,/文字太长/);reply(c,null,'文字太长');await bad;assert.equal(c.sent.length,2);reply(c,{ok:true});assert.deepEqual(await b,{ok:true});}finally{await f.close();}
});
test('发送失败/连接断开立即清理当前及等待任务，下次请求可恢复',async()=>{
 for(const mode of ['send','disconnect']){const f=await fixture();try{const a=f.engine.call('generate'),b=f.engine.call('generate');const waits=[assert.rejects(a),assert.rejects(b)];const old=f.children[0];if(mode==='send')old.callback(Error('IPC failed'));else old.emit('disconnect');await Promise.all(waits);assert.equal(f.engine.active,null);assert.equal(f.engine.queue.length,0);const next=f.engine.call('catalog');const current=f.children[1];old.emit('message',{id:current.sent[0].id,data:{wrong:true}});assert.ok(f.engine.active);reply(current,{ok:true});assert.deepEqual(await next,{ok:true});}finally{await f.close();}}
});
test('超时重启继续排队，保持扩展开关；停止后拒绝所有任务且不重启',async()=>{
 const f=await fixture({timeout:30,extensionEnabled:false});try{const c=f.engine.call('catalog');reply(f.children[0],{extensionEnabled:true});await c;const a=f.engine.call('generate'),bad=assert.rejects(a,/已取消/);const b=f.engine.call('generate');await bad;assert.equal(f.children.length,2);assert.equal(f.children[1].env.MEME_EXTENSION_ENABLED,'1');reply(f.children[1],{ok:true});await b;
 const d=f.engine.call('generate'),e=f.engine.call('generate');const waits=[assert.rejects(d,/停止/),assert.rejects(e,/停止/)];f.engine.dispose();await Promise.all(waits);await assert.rejects(f.engine.call('catalog'),/停止/);assert.equal(f.children.length,2);
 }finally{await f.close();}
});
