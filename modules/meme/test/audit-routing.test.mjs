import test from 'node:test';import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';import {tmpdir} from 'node:os';import {join} from 'node:path';
import module from '../index.mjs';import {Engine} from '../lib/engine.mjs';import {seedRuntimeMetadata} from './helpers/runtime.mjs';
test('命令入口保留真实 @、不吞掉“开”字开头的模板、快捷预览带选项，停止只清理一次',async()=>{
 const dir=await mkdtemp(join(tmpdir(),'meme-routing-'));await seedRuntimeMetadata(dir);
 const item={key:'fixture',keywords:['开车'],shortcuts:[{pattern:'哭版',names:[],texts:[],options:{mode:{type:'String',field0:'cry'}}}],params:{minImages:1,maxImages:1,minTexts:0,maxTexts:0,defaultTexts:['只供预览'],options:[]}};
 const original=Engine.prototype.call;const calls=[],replies=[],images=[],callbacks=[];let command,handle;
 const api={dir,dataDir:n=>join(dir,n),settings:()=>({...module.defaults,cooldown:0,extensionEnabled:false}),log:{info(){},warn(){},error(){}},on(){},route(){},command:c=>command=c,onDispose:c=>callbacks.push(c),isOwner:()=>true,saveSettings(){},reply:async(m,t)=>replies.push(t),sendSegments:async()=>true,lib:()=>({fetchImage:async url=>{images.push(url);return Buffer.from('image');}})};
 Engine.prototype.call=async(op,args)=>{if(op==='catalog')return{items:[item],version:'fixture'};calls.push({op,args});return{mime:'image/png',base64:'aA=='};};
 try{handle=await module.setup(api);const msg={kind:'group',chatId:'group:1124796156',groupId:'1124796156',userId:'111111',nickname:'甲',text:'/表情 开车 @乙',raw:{simulated:true,self_id:'333333',message:[{type:'text',data:{text:'/表情 开车 '}},{type:'at',data:{qq:'222222',name:'乙'}}]}};
 await command.run('开车 @乙',msg);assert.equal(calls.at(-1).args.key,'fixture');assert.deepEqual(calls.at(-1).args.texts,[]);assert.match(images[0],/nk=222222/);assert.deepEqual(replies,[]);
 await handle.handle({...msg,text:'#表情预览 哭版',raw:{simulated:true}});assert.equal(calls.at(-1).args.options.mode.field0,'cry');
 assert.equal(await handle.handle({...msg,text:'开车',raw:{simulated:true}}),false);
 handle.dispose();callbacks[0]();
 }finally{handle?.dispose();Engine.prototype.call=original;await rm(dir,{recursive:true,force:true});}
});
