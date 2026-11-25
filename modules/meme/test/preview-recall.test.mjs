import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createPreviewRecall } from '../lib/preview-recall.mjs';
import module from '../index.mjs';
import { Engine } from '../lib/engine.mjs';
import { seedRuntimeMetadata } from './helpers/runtime.mjs';
const settle = () => new Promise(setImmediate);

test('只撤回确认的发出消息，严格等待三秒；每条独立计时并及时释放', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const calls = [], warnings = [];
  const recall = createPreviewRecall({onebot: async (...args) => calls.push(args), log: {warn: x => warnings.push(x)}});
  recall.add({message_id: -123});
  t.mock.timers.tick(2999); assert.equal(calls.length, 0);
  recall.add({message_id: '456'});
  t.mock.timers.tick(1);
  assert.deepEqual(calls, [['delete_msg', {message_id: -123}, {timeoutMs: 5000, retries: 0}]]);
  t.mock.timers.tick(2999); assert.equal(calls[1][1].message_id, '456');
  t.mock.timers.tick(30000); assert.equal(calls.length, 2);
  assert.deepEqual(warnings, []); recall.dispose();
});

test('模拟、缺少回执、异常 ID 和卸载都不会误撤回；失败不泄漏内部信息', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const calls = [], warnings = [];
  const recall = createPreviewRecall({onebot: async (...args) => { calls.push(args); throw Error('C:\\private\\token.js:42 /home/secret'); }, log: {warn: x => warnings.push(x)}});
  recall.add({message_id: 1}, true);
  for (const value of [null, true, {}, {message_id: 'sim-1'}, {message_id: 0}, {message_id: {}}, {message_id: Infinity}, {message_id: Number.MAX_SAFE_INTEGER + 1}]) recall.add(value);
  t.mock.timers.tick(3000); assert.equal(calls.length, 0);
  recall.add({message_id: 2}); t.mock.timers.tick(3000); await settle(); assert.equal(calls.length, 1);
  assert.doesNotMatch(warnings.join('\n'), /private|token|secret|home|:42/);
  recall.add({message_id: 3}); recall.dispose(); recall.dispose(); recall.add({message_id: 4});
  t.mock.timers.tick(30000); assert.equal(calls.length, 1);
});

test('真实模块：群聊和私聊仅预览撤回，从发送成功开始；成品、目录、面板、模拟不撤回', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'meme-preview-')); await seedRuntimeMetadata(dir);
  const original = Engine.prototype.call, calls = [], replies = [], sent = [], routes = new Map();
  const item = {key:'fixture',keywords:['测试表情'],shortcuts:[],params:{minImages:0,maxImages:0,minTexts:0,maxTexts:0,defaultTexts:[],options:[]}};
  Engine.prototype.call = async op => op === 'catalog' ? {items:[item],version:'fixture'} : {mime:'image/png',base64:'aA=='};
  let instance, finishSend, delayed = false, sendFailure = false;
  const api = {dir,dataDir:n=>join(dir,n),settings:()=>({...module.defaults,extensionEnabled:false,cooldown:0}),log:{info(){},warn(){},error(){}},on(){},route:(p,fn)=>routes.set(p,fn),command(){},onDispose(){},isOwner:()=>true,reply:async(m,text)=>replies.push(text),
    sendSegments:async(...args)=>{sent.push(args);if(delayed)await new Promise(r=>finishSend=r);if(sendFailure)throw Error('/home/private/key.js:22');return{message_id:sent.length+100};},onebot:async(...args)=>calls.push(args),core:{http:{body:async r=>r.body}}};
  const msg = {kind:'group',groupId:'912291047',chatId:'group:912291047',userId:'10000001',messageId:'999',raw:{},text:'#表情预览 测试表情'};
  try {
    instance = await module.setup(api);
    t.mock.timers.enable({apis:['setTimeout']});
    delayed = true; const pending = instance.handle(msg); await settle();
    t.mock.timers.tick(30000); assert.equal(calls.length,0);
    finishSend(); await pending; delayed=false;
    t.mock.timers.tick(2999); assert.equal(calls.length,0);t.mock.timers.tick(1);
    assert.equal(calls[0][1].message_id,101); assert.notEqual(calls[0][1].message_id,msg.messageId);
    await instance.handle({...msg,kind:'private',chatId:'private:10000001'});t.mock.timers.tick(3000);assert.equal(calls.length,2);
    await instance.handle({...msg,text:'#测试表情'});
    await instance.handle({...msg,text:'#表情列表图片'});
    await instance.handle({...msg,raw:{simulated:true}});
    await routes.get('/preview')({method:'POST',socket:{remoteAddress:'127.0.0.1'},body:{key:'fixture'}});
    t.mock.timers.tick(30000);assert.equal(calls.length,2);
    await instance.handle({...msg,text:'#表情预览'});assert.match(replies.at(-1),/用法.*3 秒/);
    sendFailure=true;await instance.handle(msg);assert.doesNotMatch(replies.at(-1),/private|key.js|home/);sendFailure=false;
    await instance.handle(msg);instance.dispose();t.mock.timers.tick(30000);assert.equal(calls.length,2);
    assert.equal(await instance.handle(msg),false);
  } finally {instance?.dispose();Engine.prototype.call=original;await rm(dir,{recursive:true,force:true});}
});

test('卸载期间完成或失败的任务不再发消息，也不重新创建统计和撤回计时器', async t => {
  for (const stage of ['generate', 'send', 'send-error']) {
    const dir = await mkdtemp(join(tmpdir(), 'meme-dispose-')); await seedRuntimeMetadata(dir);
    const original = Engine.prototype.call, replies = [], sent = [];
    let finish, instance;
    const gate = new Promise(r=>finish=r);
    const item = {key:'fixture',keywords:['测试表情'],shortcuts:[],params:{minImages:0,maxImages:0,minTexts:0,maxTexts:0,defaultTexts:[],options:[]}};
    Engine.prototype.call=async op=>{if(op==='catalog')return{items:[item],version:'fixture'};if(stage==='generate')await gate;return{mime:'image/png',base64:'aA=='};};
    const api={dir,dataDir:n=>join(dir,n),settings:()=>({...module.defaults,extensionEnabled:false,cooldown:0}),log:{info(){},warn(){},error(){}},on(){},route(){},command(){},onDispose(){},isOwner:()=>true,reply:async(m,x)=>replies.push(x),sendSegments:async()=>{sent.push(1);await gate;if(stage==='send-error')throw Error('internal');return{message_id:10};},onebot:async()=>assert.fail('卸载后不撤回')};
    try {
      instance=await module.setup(api);
      const work=instance.handle({kind:'private',chatId:'private:10000001',userId:'10000001',text:'#测试表情',raw:{}});
      await settle();instance.dispose();
      const timer=t.mock.method(globalThis,'setTimeout');
      finish();await work;
      assert.equal(timer.mock.callCount(),0,stage);timer.mock.restore();
      assert.deepEqual(replies,[]);assert.equal(sent.length,stage==='generate'?0:1);
    }finally{instance?.dispose();Engine.prototype.call=original;await rm(dir,{recursive:true,force:true});}
  }
});
