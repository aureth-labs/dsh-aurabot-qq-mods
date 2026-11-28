import test from 'node:test'
import assert from 'node:assert/strict'
import {mkdtempSync} from 'node:fs'
import {tmpdir} from 'node:os'
import {join} from 'node:path'
import {RelationService} from '../relationship/lib/service.mjs'
import {SDK} from '../relationship/lib/policy.mjs'
import {CALIBRATION} from '../relationship/lib/calibration.mjs'
const profile={provider:CALIBRATION.provider,model:CALIBRATION.model,reasoningEffort:'off'}
function fixture(t){
 let at=Date.now(),calls=0,available=true,memoryFail=false,liveReady=true,delivered=new Map(),mood=50,modelError=null,flat=false
 const old=globalThis[SDK];globalThis[SDK]={api:1};const config={ownerQQ:'1',persona:{current:'a'}},settings={enabled:true,captureEnabled:true,optionalEnabled:false}
 const captured={input:{persona:'a',subject:'1',audience:'private'},generation:1}
 const records=new Map(),gate={managed:()=>true,session:id=>id==='s'?{persona:'a',chatId:'private:1',generation:1}:null,capture:()=>captured,assert:()=>{}}
 const service=new RelationService({file:join(mkdtempSync(join(tmpdir(),'relation-live-')),'data.sqlite'),config:()=>config,settings:()=>settings,memory:()=>gate,now:()=>at,dependencies:()=>({resetReady:true,liveReady}),sourceCheck:()=>available,archive:{recent:()=>[],find:(_,id)=>records.get(id),check:()=>available},deliver:async(kind,p)=>{if(kind==='memory'&&memoryFail)throw Error('memory temporarily failed');if(delivered.has(p.id||p.sourceId))return {applied:false,duplicate:true,actualDelta:delivered.get(p.id||p.sourceId)};const delta=kind==='mood'?p.delta:0;if(kind==='mood')mood+=delta;delivered.set(p.id||p.sourceId,delta);return kind==='mood'?{applied:true,actualDelta:delta}:{ok:true}},model:async({input})=>{calls++;if(modelError)throw Error(modelError);return {output:JSON.stringify({v:2,events:flat?[]:[{c:'care',d:'up',s:'owner',t:'role',e:[[input.sources[0].sourceId,input.sources[0].text]],n:0,q:.9,f:[],p:[],phase:'none',l:'合成关心',u:[]}]}),finishReason:'stop',usage:{inputTokens:100,outputTokens:40}}}})
 service.create('a');service.save({persona:'a',revision:1,patch:{mode:'auto',judge:profile}})
 const begin=(id,{nativeMoodObserved=false,withReceipt=true,text='这次关心内容 '+id}={})=>{
  at++;const source={sourceId:'qq:'+id,actor:'1',kind:'user',text,nativeMoodObserved};records.set(source.sourceId,{...source,at})
  const token=service.collector.open({sessionId:'s',chatId:'private:1',sources:[source]});assert.ok(token)
  if(withReceipt)service.collector.receipt(token,{sourceId:'qq:'+(1000+id),text:'谢谢你',coveredIds:[source.sourceId]})
  return token
 }
 const say=async(id,options)=>{const result=service.collector.finish(begin(id,options),{completed:true});await service.queue;return result}
 t.after(async()=>{await service.dispose();if(old)globalThis[SDK]=old;else delete globalThis[SDK]})
 return {s:service,say,begin,captured,records,config,settings,calls:()=>calls,mood:()=>mood,failMemory:v=>memoryFail=v,setAvailable:v=>available=v,setReady:v=>liveReady=v,advance:v=>at+=v,modelFails:v=>modelError=v,setFlat:()=>flat=true}
}
test('自动主人私聊一次判定一次提交，影子独立；重复消息零额外调用',async t=>{
 const f=fixture(t);await f.say(1);const snap=f.s.snapshot();assert.equal(snap.row.state.score,5);assert.equal(snap.committed.state.score,5);assert.equal(snap.simulation,null);assert.equal(f.mood(),54);assert.equal(snap.outbox.length,0)
 await f.say(1);assert.equal(f.calls(),1);assert.equal(f.s.store.get('a','1').state.score,5)
 assert.equal(f.s.ownsMood({kind:'out',chatId:'private:1'}),false);assert.equal(f.s.ownsMood({kind:'out',chatId:'group:1'}),false)
})
test('有效配置、实际核实收发、持平结算和空来源分别报告，内部空来源正常',async t=>{
 const f=fixture(t)
 assert.equal(f.s.snapshot().automatic.configured,true)
 assert.equal(f.s.snapshot().automatic.observed,null)
 const noSources={sessionId:'s',chatId:'private:1',sources:[]}
 assert.equal(f.s.collector.open(noSources),null)
 assert.equal(f.s.snapshot().automatic.observed,null)
 assert.equal(f.s.collector.open({...noSources,expectSources:true}),null)
 assert.equal(f.s.snapshot().automatic.observed.skip.code,'missing-sources')
 assert.equal(f.s.snapshot().automatic.lastSettledAt,null)
 f.setFlat()
 const token=f.begin(5)
 assert.ok(f.s.snapshot().automatic.observed.openedAt)
 assert.equal(f.s.snapshot().automatic.lastSettledAt,null)
 f.s.collector.finish(token,{completed:true});await f.s.queue
 const s=f.s.snapshot()
 assert.ok(s.automatic.observed.closedAt)
 assert.ok(s.automatic.lastSettledAt)
 assert.equal(s.capture.modelCalls,1)
 const history=f.s.store.committed.page(s.row,{status:'all'}).rows
 assert.equal(history[0].type,'round');assert.equal(history[0].result.actualDelta,0)
})
test('心情按实际轮次接管，断回执或用量拦截时允许同一轮一次原生处理',async t=>{
 const f=fixture(t)
 const token=f.begin(1,{withReceipt:false})
 const activity={kind:'out',chatId:'private:1',relationTurn:token}
 assert.equal(f.s.ownsMood({...activity,chatId:'private:2'}),false)
 const claim=f.s.ownsMood(activity)
 f.s.collector.finish(token,{completed:true});assert.equal(await claim,false)
 assert.equal(f.s.ownsMood(activity),true)
 f.s.save({persona:'a',revision:2,patch:{judge:{dailyRequests:0}}})
 const limited=f.begin(2),budget=f.s.ownsMood({...activity,relationTurn:limited})
 f.s.collector.finish(limited,{completed:true});assert.equal(await budget,false)
 assert.equal(f.s.snapshot().automatic.observed.skip.code,'judge-budget');assert.equal(f.calls(),0)
 f.s.save({persona:'a',revision:3,patch:{judge:{dailyRequests:10}}})
 f.modelFails('do not include private error data in health')
 const failed=f.begin(3),taken=f.s.ownsMood({...activity,relationTurn:failed})
 f.s.collector.finish(failed,{completed:true});assert.equal(await taken,true);await f.s.queue
 assert.equal(f.s.snapshot().automatic.observed.skip.code,'judge-unapplied');assert.equal(f.calls(),1)
 assert(!JSON.stringify(f.s.snapshot().automatic).includes('private error data'))
})
test('原生关键词已应用心情时，同一消息仍结算关系轴但不重复写心情',async t=>{
 const f=fixture(t)
 const token=f.begin(1,{nativeMoodObserved:true})
 const mood=f.s.ownsMood({kind:'out',chatId:'private:1',relationTurn:token})
 assert.equal(f.s.collector.finish(token,{completed:true}).captured,true)
 assert.equal(await mood,true);await f.s.queue
 assert.equal(f.s.snapshot().row.state.score,5)
 assert.equal(f.mood(),50)
 assert.equal(f.s.snapshot().committedEvents[0].result.mood,0)
})
test('同步失败不回滚关系也不二次加分，补投递后可撤销实际关系并保留后续手动校准',async t=>{
 const f=fixture(t);f.failMemory(true);await f.say(1);let row=f.s.store.get('a','1');assert.equal(row.state.score,5);assert.equal(f.s.live.pending(row).length,1);assert.equal(f.mood(),54)
 f.failMemory(false);await f.s.live.drain(row,f.captured);assert.equal(f.mood(),54);assert.equal(f.calls(),1)
 f.s.adjust({persona:'a',score:50,expectedRevision:row.state.revision});await f.say(2);row=f.s.store.get('a','1')
 const ledger=f.s.store.committed,entries=ledger.entries(row),first=entries.find(e=>e.type==='round'&&e.command.sources[0].sourceId==='qq:1')
 const input={entryId:first.id,expectedRevision:ledger.get(row).revision,reason:'合成误判',confirmed:true},preview=f.s.live.previewUndo(row,input);assert.equal(preview.after.score,55);assert.equal(preview.moodDelta,-4)
 f.s.live.undo(row,input);await f.s.live.drain(row,f.captured);assert.equal(f.s.store.get('a','1').state.score,55);assert.equal(f.mood(),54);assert.equal(f.calls(),2)
})
test('自动配置、发送接口及语义模型门禁不能被全局继承绕过',async t=>{
 const f=fixture(t);f.s.save({persona:'a',revision:2,patch:{mode:'auto',judge:{reasoningEffort:'high'}}});assert.equal(f.s.automaticReady(f.s.store.get('a','1')),false)
 f.s.save({persona:'a',revision:3,patch:{judge:{reasoningEffort:'off'}}})
 assert.equal(f.s.store.get('a','1').config.judge.reasoningEffort,'off')
 f.setReady(false);assert.equal(f.s.automaticReady(f.s.store.get('a','1')),false);assert.equal(f.s.ownsMood({chatId:'private:1'}),false)
 assert.throws(()=>f.s.saveDefaults({patch:{mode:'auto'},revision:0}),/按人格设置/)
})

test('主动分享后玩家明确引用实际已发送消息，即使当轮静默也形成交流；未知引用不算',async t=>{
 const f=fixture(t),source={sourceId:'qq:22',actor:'1',kind:'user',text:'这个视频让我想到以前一起去的地方',replyTo:'qq:11'}
 f.records.set('qq:11',{sourceId:'qq:11',actor:'role:a',persona:'a',chatId:'private:1',kind:'assistant',delivery:'sent',text:'看到一个旅行视频想分享给你',at:f.s.now()-1000})
 let token=f.s.collector.open({sessionId:'s',chatId:'private:1',sources:[source]});assert.ok(token)
 assert.equal(f.s.collector.finish(token,{completed:true}).captured,true);await f.s.queue;assert.equal(f.calls(),1);assert.equal(f.s.snapshot().row.state.score,5)
 token=f.s.collector.open({sessionId:'s',chatId:'private:1',sources:[{...source,sourceId:'qq:23',replyTo:'qq:999'}]})
 assert.equal(f.s.collector.finish(token,{completed:true}).captured,false);await f.s.queue;assert.equal(f.calls(),1)
})

test('相邻自动轮正常提交不会丢掉在途交流，手动校准仍取消它',async t=>{
 const f=fixture(t),source={sourceId:'qq:40',actor:'1',kind:'user',text:'晚饭吃了吗'}
 let token=f.s.collector.open({sessionId:'s',chatId:'private:1',sources:[source]})
 f.s.collector.receipt(token,{sourceId:'qq:41',text:'吃了',coveredIds:['qq:40']})
 await f.say(1);assert.equal(f.s.collector.finish(token,{completed:true}).captured,true);await f.s.queue;assert.equal(f.calls(),2)
 token=f.s.collector.open({sessionId:'s',chatId:'private:1',sources:[{...source,sourceId:'qq:42'}]})
 f.s.adjust({persona:'a',score:70,expectedRevision:f.s.snapshot().row.state.revision})
 assert.equal(f.s.collector.finish(token,{completed:true}).captured,false)
})

test('重复同步同一待处理队列只有一个投递者',async t=>{
 const f=fixture(t);f.failMemory(true);await f.say(1);const row=f.s.store.get('a','1');let calls=0,release
 f.s.deliver=async()=>{calls++;await new Promise(resolve=>release=resolve);return {ok:true}}
 const a=f.s.live.drain(row,f.captured),b=f.s.live.drain(row,f.captured);assert.equal(calls,1);release();await Promise.all([a,b]);assert.equal(f.s.live.pending(row).length,0)
})

test('连续撤销先后事件时，后续重复衰减重算的心情不会少补或多补',async t=>{
 const f=fixture(t),entryIds=[]
 for(let i=0;i<2;i++){const row=f.s.store.get('a','1'),sourceId='qq:'+i,event={category:'care',state:'up',qualified:true,reasons:[],label:'同事实',factKey:'same',evidence:[{sourceId,quote:'synthetic'}],severity:0};entryIds.push(f.s.live.commit(row,{events:[event],sources:[{sourceId}],at:Date.now()},{requestId:'double-'+i}).id);await f.s.live.drain(row,f.captured)}
 for(const entryId of entryIds){const row=f.s.store.get('a','1');f.s.live.undo(row,{entryId,expectedRevision:f.s.store.committed.get(row).revision,reason:'连续纠错',confirmed:true});await f.s.live.drain(row,f.captured)}
 assert.equal(f.mood(),50);assert.equal(f.s.snapshot().row.state.score,0)
})

test('可选轴须同时启用；按阶段增长、半衰期回归和有来源回落，重置不改关系',async t=>{
 const f=fixture(t);f.s.save({persona:'a',revision:2,patch:{optionalEnabled:true,stageGate:3,rules:{turnArousal:10},arousal:{enabled:true,stageCoefficients:[1,1,2,2,2]}}});let row=f.s.store.get('a','1')
 assert.equal(f.s.snapshot().optionalDisplay,'第 3 阶段起')
 f.settings.optionalEnabled=true
 assert.equal(f.s.snapshot().optionalDisplay,'第 3 阶段起')
 f.s.adjust({persona:'a',stage:3,expectedRevision:row.state.revision});row=f.s.store.get('a','1')
 assert.equal(f.s.snapshot().optionalDisplay,row.config.arousal.tendencies.low)
 assert.ok(f.s.contextForSession({id:'s'}).text.includes(f.s.snapshot().optionalDisplay))
 const event={category:'ask-intimate',state:'up',qualified:true,reasons:[],label:'合成亲密表达',factKey:'optional',evidence:[{sourceId:'qq:80',quote:'合成'}],severity:0}
 f.s.live.commit(row,{events:[event],sources:[{sourceId:'qq:80'}],at:Date.now(),optionalActive:false},{requestId:'off'});assert.equal(f.s.snapshot().optionalValue,10)
 row=f.s.store.get('a','1');f.s.live.commit(row,{events:[{...event,factKey:'optional-new'}],sources:[{sourceId:'qq:81'}],at:Date.now()+1,optionalActive:true},{requestId:'on'});assert.equal(f.s.snapshot().optionalValue,20)
 f.advance(row.config.arousal.halfLifeHours*3600000);assert.ok(Math.abs(f.s.snapshot().optionalValue-15)<.01)
 row=f.s.store.get('a','1')
 f.s.setOptional({persona:'a',kind:'drop',sourceId:'qq:81',quote:'合成',expectedRevision:row.state.revision,confirmed:true});assert.ok(f.s.snapshot().optionalValue<15)
 assert.equal(f.s.snapshot().optionalDisplay,row.config.arousal.tendencies.low)
 f.config.persona.current='b'
 assert.equal(f.s.snapshot('a').optionalDisplay,'已暂停')
 f.config.persona.current='a'
 row=f.s.store.get('a','1');f.s.setOptional({persona:'a',kind:'reset',expectedRevision:row.state.revision,confirmed:true});assert.equal(f.s.snapshot().optionalValue,10);assert.equal(f.s.snapshot().row.state.score,45)
})
test('源证明须引用可用原文且前约独立，撤回后不再使用',async t=>{
 const f=fixture(t);f.records.set('qq:100',{sourceId:'qq:100',actor:'1',text:'明天拍海边给你看',at:Date.now()-86400000})
 let row=f.s.store.get('a','1');assert.throws(()=>f.s.facts.confirm(row,{kind:'commitment',sourceId:'qq:100',quote:'不存在',expectedRevision:1}),/来源/)
 const prior=f.s.facts.confirm(row,{kind:'commitment',sourceId:'qq:100',quote:'明天拍海边给你看',expectedRevision:1});assert.equal(f.s.facts.available(row,f.captured).length,1)
 f.records.set('qq:101',{sourceId:'qq:101',actor:'1',text:'海边照片拍好了',at:Date.now()});const done=f.s.facts.confirm(row,{kind:'fulfillment',sourceId:'qq:101',quote:'海边照片拍好了',relatedId:prior.id,expectedRevision:1});assert.equal(done.relatedId,prior.id)
 f.s.facts.revoke(row,{id:prior.id});assert.equal(f.s.facts.available(row,f.captured).length,0);assert.equal(f.s.facts.list(row).filter(x=>x.status==='revoked').length,2);f.setAvailable(false);assert.equal(f.s.facts.available(row,f.captured).length,0)
})
test('实际网络调用租约只准一次，过期/加输出预算/非文本均拒绝',t=>{
 const f=fixture(t),controller=new AbortController(),release=f.s.leaseModel('one',800,controller.signal),options={messages:[{id:'one',source:{plugin:'character-relation'},content:[{type:'text',text:'合成'}]}],maxTokens:800}
 assert.equal(f.s.claimModel(options),true);assert.throws(()=>f.s.claimModel(options),/重试/);release();assert.throws(()=>f.s.claimModel(options),/过期/)
})
test('有限快照清理不删来源墓碑，撤销重放仍有完整起始状态',async t=>{
 const f=fixture(t);f.s.save({persona:'a',revision:2,patch:{replayLimit:10}})
 for(let i=1;i<=14;i++)await f.say(i)
 const row=f.s.store.get('a','1'),l=f.s.store.committed;assert.equal(l.entries(row).length,10);assert.equal(l.hasSources(row,[{sourceId:'qq:1'}]),true)
 const target=l.entries(row).at(-1);assert.ok(f.s.live.previewUndo(row,{entryId:target.id,expectedRevision:l.get(row).revision}).after)
})

test('同轮判定关联同义关心，独立事件保留自己的奖励',async t=>{
 const f=fixture(t),inputs=[]
 const model=f.s.model
 f.s.model=async args=>{
  inputs.push(args.input)
  const result=await model(args)
  if(inputs.length===2){
   const out=JSON.parse(result.output)
   assert.equal(args.input.recentInteractions[0].id,'r0')
   out.events[0].r='r0'
   result.output=JSON.stringify(out)
  }
  return result
 }
 f.s.archive.recent=()=>[...f.records.values()]
 for(const [index,text] of ['今晚早点睡','今晚要早点休息','下雨了，我给你送伞'].entries())await f.say(index+1,{text})
 const events=f.s.store.committed.entries(f.s.store.get('a','1')).reverse().map(e=>e.result.events[0])
 assert.deepEqual(events.map(e=>e.repeatFactor),[1,.5,1])
 assert.equal(inputs.length,3)
})
