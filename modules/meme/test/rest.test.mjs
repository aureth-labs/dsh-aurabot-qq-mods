import test from 'node:test';import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';import {tmpdir} from 'node:os';import {join} from 'node:path';
import module from '../index.mjs';import {Engine} from '../lib/engine.mjs';import {seedRuntimeMetadata} from './helpers/runtime.mjs';
import {isResting,validateRest} from '../lib/rest.mjs';
const G='912291047';const rest={enabled:true,groups:[G],start:'00:00',end:'07:00'};
const msg={kind:'group',chatId:'group:'+G,groupId:G,userId:'10000001',nickname:'甲',raw:{simulated:true}};
test('半开区间、跨午夜、私聊和其他群互不影响',()=>{
 const check=(start,end,h,m)=>isResting({rest:{...rest,start,end}},msg,new Date(2026,10,15,h,m));
 assert.equal(check('00:00','07:00',0,0),true);assert.equal(check('00:00','07:00',6,59),true);assert.equal(check('00:00','07:00',7,0),false);
 assert.equal(check('23:30','07:00',23,29),false);assert.equal(check('23:30','07:00',23,30),true);assert.equal(check('23:30','07:00',1,0),true);assert.equal(check('23:30','07:00',12,0),false);
 for(const other of [{...msg,kind:'private'},{...msg,groupId:'30000003'}])assert.equal(isResting({rest},other,new Date(2026,10,15,1)),false);
 assert.equal(isResting({rest:{...rest,enabled:false}},msg),false);
 for(const patch of [{groups:[]},{groups:['群912291047']},{groups:[G+'/12345']},{start:'7:00'},{end:'24:00'},{end:'00:00'},{enabled:'true'},{unknown:true}])assert.throws(()=>validateRest({...rest,...patch}));
 assert.deepEqual(validateRest({...rest,groups:[G,G]}).groups,[G]);
});
test('真实模块：夜间静默、不启动制作、不落到 AI；白天恢复；在途结果不迟到；保存冲突和异常安全',async t=>{
 const dir=await mkdtemp(join(tmpdir(),'meme-rest-'));await seedRuntimeMetadata(dir);
 const item={key:'fixture',keywords:['测试表情'],shortcuts:[],params:{minImages:0,maxImages:0,minTexts:0,maxTexts:0,defaultTexts:[],options:[]}};
 const original=Engine.prototype.call;const calls=[],replies=[],sent=[],routes=new Map();let command,instance,gate;
 let settings={...module.defaults,extensionEnabled:false,cooldown:0,rest};
 const api={dir,dataDir:n=>join(dir,n),settings:()=>settings,saveSettings:patch=>{settings={...settings,...patch}},log:{info(){},warn(){},error(){}},on(){},route:(p,fn)=>routes.set(p,fn),command:c=>command=c,onDispose(){},isOwner:()=>true,reply:async(m,text)=>replies.push(text),sendSegments:async(...args)=>{sent.push(args);return{message_id:1}},core:{http:{body:async r=>r.body}}};
 Engine.prototype.call=async function(op,args){if(op==='catalog')return{items:[item],version:'fixture'};calls.push(op);if(gate)await gate;return{mime:'image/png',base64:'aA=='};};
 t.mock.timers.enable({apis:['Date'],now:new Date(2026,10,15,6,59).getTime()});
 try{
  instance=await module.setup(api);
  for(const text of ['#测试表情','#表情列表','#表情预览 测试表情','#表情帮助','#表情关','#表情 不存在'])assert.equal(await instance.handle({...msg,text}),true);
  await command.run('测试表情',{...msg,text:'/表情 测试表情'});
  assert.deepEqual(calls,[]);assert.deepEqual(replies,[]);assert.deepEqual(sent,[]);assert.equal(settings.enabled,true);
  assert.equal(await instance.handle({...msg,text:'普通聊天'}),false);assert.equal(await instance.handle({...msg,text:'#别的模块'}),false);
  await instance.handle({...msg,groupId:'30000003',chatId:'group:30000003',text:'#测试表情'});assert.equal(sent.length,1);
  await instance.handle({...msg,kind:'private',chatId:'private:10000001',text:'#表情帮助'});assert.equal(replies.length,1);
  t.mock.timers.setTime(new Date(2026,10,15,7,0).getTime());await instance.handle({...msg,text:'#测试表情'});assert.equal(sent.length,2);
  // Start before midnight, finish during rest. No late image or failure message.
  t.mock.timers.setTime(new Date(2026,10,15,23,59).getTime());let finish;gate=new Promise(r=>finish=r);
  const work=instance.handle({...msg,text:'#测试表情'});await new Promise(setImmediate);
  t.mock.timers.setTime(new Date(2026,10,16,0,0).getTime());finish();await work;gate=null;assert.equal(sent.length,2);assert.equal(replies.length,1);
  const route=routes.get('/rest'),req={method:'POST',socket:{remoteAddress:'127.0.0.1'}};
  const old=structuredClone(settings.rest);
  assert.equal((await route({...req,body:{rest:{...rest,groups:[]},expected:old}})).ok,false);assert.deepEqual(settings.rest,old);
  assert.equal((await route({...req,body:{rest:{...rest,start:'22:00'},expected:{}}})).ok,false);assert.deepEqual(settings.rest,old);
  assert.equal((await route({...req,body:{rest:{...rest,start:'22:00'},expected:old}})).ok,true);
  api.saveSettings=()=>{throw Error('EACCES C:\\private\\secret.js at fn:23')};
  const failed=await route({...req,body:{rest,expected:settings.rest}});assert.equal(failed.ok,false);assert.doesNotMatch(JSON.stringify(failed),/EACCES|secret|private|fn:23/);
 }finally{instance?.dispose();Engine.prototype.call=original;await rm(dir,{recursive:true,force:true});}
});
