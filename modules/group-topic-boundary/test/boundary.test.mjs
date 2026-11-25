import {test} from 'node:test'
import assert from 'node:assert/strict'
import {mkdtempSync,rmSync,writeFileSync} from 'node:fs'
import {tmpdir} from 'node:os'
import {join} from 'node:path'
import mod,{REDIRECT,GROUP_RULE,explicitTopic} from '../index.mjs'
const {createHub} = await import(new URL('chat/hub.js', globalThis.aurabot.src))
const {normalize} = await import(new URL('core/config.js', globalThis.aurabot.src))
const {createModules} = await import(new URL('core/modules.js', globalThis.aurabot.src))
function moduleApi(){const hooks={},logs=[],rules=[];mod.setup({on:(k,fn)=>hooks[k]=fn,rule:fn=>rules.push(fn),log:{info:line=>logs.push(line)}});return {hooks,logs,rules}}
const G={chatId:'group:123456789'},P={chatId:'private:123'}
test('规则解释范围、连续追问与工具变形，且只有一个模块开关',()=>{
 const s=moduleApi();assert.equal(s.rules[0]('social'),GROUP_RULE);assert.equal(s.rules[0]('private'),GROUP_RULE)
 for(const word of ['普通私聊不受','委托代发','过去的回复','语音','不确定','搜索'])assert.ok(GROUP_RULE.includes(word))
 assert.equal(mod.settings,undefined);assert.equal(mod.defaults,undefined)
})
test('明确内容、传统字、标签拆字、标点拆字、语音和英文均可兜底',()=>{
 for(const text of ['文革的发起人','文化大革命','四人幫','習近平','毛，泽。东','毛<face:微笑>泽东','<voice>周恩来</voice>','刘\u200b少奇','六四事件','Tell me about Xi Jinping now','Mao-Zedong','the Cultural Revolution was']) assert.equal(explicitTopic(text),true,text)
})
test('普通新闻、地理、文学、游戏与泛词不过滤',()=>{
 for(const text of ['中国的法定节假日有哪些','台湾旅游如何安排行程','今天新闻说要下雨','民主和政治是课程名字','历史书很好看','天安门看升旗几点','我的胜率六四开','六十四个方格','三体里的叶文洁和汪淼','主席台上的运动员','白米饭','<sticker:开心>'])assert.equal(explicitTopic(text),false,text)
})
test('只检查群聊输出，不读提问、不改私聊和无关内容',()=>{
 const {hooks}=moduleApi()
 assert.equal(hooks.reply('文革话题',G),REDIRECT)
 assert.equal(hooks.reply('文革话题',P),undefined)
 assert.equal(hooks.reply('换聊游戏吧',{...G,userText:'别再说文革了'}),undefined)
 assert.equal(hooks.reply('聊游戏',G),undefined)
 assert.equal(hooks.reply('文革话题',{}),undefined)
})
test('后置条目检查覆盖完整语音正文，替换整轮而非残留半句话',()=>{
 const {hooks}=moduleApi();const items=[{kind:'voice',value:'普通前言'.repeat(60)+'毛泽东'},{kind:'text',value:'再念一段'}]
 assert.deepEqual(hooks['reply/items'](items,G),[{kind:'text',value:REDIRECT}]);assert.equal(hooks['reply/items'](items,P),undefined)
 assert.deepEqual(hooks['reply/items']([{kind:'voice',value:REDIRECT},{kind:'sticker',value:'嘲讽'}],G),[{kind:'text',value:REDIRECT}])
})
test('最终出口涵盖直接发文字、拆开文本和有文字备注的语音，不读文件与图片',()=>{
 const {hooks}=moduleApi();const expected=[{type:'text',data:{text:REDIRECT}}]
 assert.deepEqual(hooks.send([{type:'text',data:{text:'毛'}},{type:'text',data:{text:'泽东'}}],G),expected)
 assert.deepEqual(hooks.send([{type:'record',data:{file:'base64://test'}}],{...G,note:'[语音] 文革'}),expected)
 assert.equal(hooks.send([{type:'record',data:{file:'base64://test'}}],{...P,note:'文革'}),undefined)
 assert.equal(hooks.send([{type:'image',data:{file:'https://example.invalid/文革.png'}}],G),undefined)
 assert.equal(hooks.send([{type:'text',data:{text:'换个聊'}}],{...G,note:'旧备注文革'}),undefined)
})
function hubSetup(t){
 const dir=mkdtempSync(join(tmpdir(),'aurabot-topic-'));const old=process.env.AURABOT_DATA_DIR;process.env.AURABOT_DATA_DIR=dir
 const s=moduleApi(),sent=[],spoken=[];let enabled=true
 const cfg=normalize({enabled:true,dryRun:false,ownerQQ:'123',allow:{groups:['123456789']},workspaceDir:dir,chat:{bubbleMinMs:0,bubbleMaxMs:0},stickers:{enabled:true,autoChance:1},voice:{enabled:true,autoChance:1,autoMaxChars:300}})
 const hooks={reply:(...a)=>enabled?s.hooks.reply(...a):undefined,items:(...a)=>enabled?s.hooks['reply/items'](...a):undefined,send:(...a)=>enabled?s.hooks.send(...a):undefined}
 const voice=join(dir,'test.wav');writeFileSync(voice,'fixture')
 const hub=createHub({dsh:{},getConfig:()=>cfg,log:{info(){},debug(){},warn(){},error(){}},hooks,onebot:{call:async(action,params)=>{sent.push({action,params});return {message_id:sent.length}}},random:()=>0,moodEffects:()=>({voice:1,sticker:1,delay:0}),tts:{speak:async text=>{spoken.push(text);return {file:voice,engine:'test'}}},stickers:{pickForReply:()=>({name:'开心'}),match:()=>({name:'开心'}),segmentFor:()=>({type:'image',data:{file:'base64://fixture'}}),markUsed(){}}})
 t.after(()=>{hub.dispose();if(old===undefined)delete process.env.AURABOT_DATA_DIR;else process.env.AURABOT_DATA_DIR=old;rmSync(dir,{recursive:true,force:true})})
 return {hub,sent,spoken,off:()=>enabled=false}
}
test('实际 hub：敏感双语音在 TTS 之前替换成一条文字，无附加表情',async t=>{
 const s=hubSetup(t);await s.hub.deliver(G.chatId,'<voice>毛泽东</voice>|||<voice>文革</voice>',{simulate:true})
 assert.equal(s.spoken.length,0);assert.equal(s.sent.length,1);assert.deepEqual(s.sent[0].params.message,[{type:'text',data:{text:REDIRECT}}])
})
test('实际 hub：跨群显式 voice=true 同样拦截；正常文字、私聊、关闭后均可发送',async t=>{
 const s=hubSetup(t);await s.hub.deliver(G.chatId,'文革',{voice:true,simulate:true});assert.equal(s.spoken.length,0)
 await s.hub.deliver(G.chatId,'白米饭真好吃',{simulate:true});assert.ok(s.spoken.includes('白米饭真好吃'))
 await s.hub.deliver(P.chatId,'文革',{voice:true,simulate:true});assert.ok(s.spoken.includes('文革'))
 const count=s.spoken.length;s.off();await s.hub.deliver(G.chatId,'文革',{voice:true,simulate:true});assert.equal(s.spoken.length,count+1)
})
test('日志只写群号和拦截动作，不记录正文、路径或任何政治标签',()=>{
 const s=moduleApi();s.hooks.reply('毛泽东 test-private-path',G);assert.equal(s.logs.length,1);assert.doesNotMatch(s.logs[0],/毛泽东|private|path/)
})

test('真实模块管理器：关闭撤销规则和钩子，重开不重复注册，卸载后无残留',async t=>{
 const dir=mkdtempSync(join(tmpdir(),'aurabot-topic-lifecycle-'));const old=process.env.AURABOT_DATA_DIR;process.env.AURABOT_DATA_DIR=dir
 let cfg=normalize({safeMode:true,modules:{}})
 const logger={info(){},warn(){},error(){},debug(){},child(){return this}}
 const mods=createModules({ctx:{},core:{hub:{}},getConfig:()=>cfg,setConfig:c=>cfg=c,logger,version:'1.2.1',builtins:[mod]})
 t.after(()=>{mods.dispose();if(old===undefined)delete process.env.AURABOT_DATA_DIR;else process.env.AURABOT_DATA_DIR=old;rmSync(dir,{recursive:true,force:true})})
 await mods.boot();assert.equal(mods.rules('social').length,1);assert.equal(await mods.filter('reply','文革',G),REDIRECT)
 cfg.modules[mod.id]={enabled:false};await mods.sync();assert.deepEqual(mods.rules('social'),[]);assert.equal(await mods.filter('reply','文革',G),'文革')
 cfg.modules[mod.id]={enabled:true};await mods.sync();await mods.sync();assert.equal(mods.rules('social').length,1);assert.equal(await mods.filter('reply','文革',G),REDIRECT)
 mods.dispose();assert.deepEqual(mods.rules('social'),[]);assert.equal(await mods.filter('reply','文革',G),'文革')
})
