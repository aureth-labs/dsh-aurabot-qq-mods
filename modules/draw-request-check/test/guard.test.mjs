import test from 'node:test'
import assert from 'node:assert/strict'
import guard, {requestOf, parseDecision} from '../index.mjs'
const approve = (...requestIds) => JSON.stringify({decision:'DRAW',requestIds})
const deny = decision => JSON.stringify({decision,requestIds:[]})
const user = (id, text) => ({role:'user',id,source:{kind:'aurabot'},content:[{type:'text',text}]})
const group = user('a','【群聊 测试】之前在聊：\n甲：画一张\n\n【群聊 测试】刚才新说的（1 条）\n[1] 乙(12345)@了你：查人物\n\n每行开头是说话人。')
const privateMsg = user('b','【私聊】甲：换成蓝色')
const runtime = {role:'user',source:{kind:'runtime-context'},content:[{type:'text',text:'绘图规则'}]}
test('only current chat input and adjacent exchange can support a draw',()=>{
 const messages=[group,{role:'assistant',content:[{type:'text',text:'有这些人物。'}]},privateMsg,runtime,{role:'user',source:{kind:'repeat-tool-reminder',form:'notice'},content:[]},{role:'tool',content:[]},{role:'assistant',content:[{type:'text',text:'我还可以画图。'}]}];
 assert.deepEqual(requestOf(messages),{id:'b',current:'【私聊】甲：换成蓝色',previous:'[1] 乙(12345)@了你：查人物',reply:'有这些人物。'});
 assert.equal(requestOf([...messages,user('scheduled','系统任务')]),null)
})
async function harness(response, finish='stop', senders){
 let hook,receive,calls=0,passed=0;const session={id:'s',deriveMessages:()=>[group]};let dispose;
 const api={on:(event,h)=>{assert.equal(event,'message');receive=h},dsh:{on:(event,h)=>{assert.equal(event,'tools/pre-execute');hook=h;return ()=>{}},llm:{async *stream(req){calls++;assert.equal(req.tools.length,0);yield {type:'text-delta',text:typeof response === 'function' ? await response(JSON.parse(req.messages[0].content[0].text),calls) : response};yield {type:'finish',reason:{kind:finish}}}}},core:{hub:{...(senders ? {turnSenders:()=>senders} : {}),modelFor:()=>({provider:'test',model:'test'}),chatOfSession:()=> 'group:123'}},onDispose:f=>dispose=f};guard.setup(api);
 const run=(name='qq_draw_image',args={},signal=new AbortController().signal)=>hook({name,arguments:args,agent:{session},signal},()=>{passed++;return {kind:'allow'}});return {run,receive,get calls(){return calls},get passed(){return passed},dispose,session}
}
test('lookup and uncertain/invalid decisions cannot start generation or its slow notice',async()=>{for(const v of [deny('OTHER'),deny('UNCLEAR'),'maybe']){const h=await harness(v);assert.equal((await h.run()).kind,'deny');assert.equal(h.passed,0);await h.run();assert.equal(h.calls,v==='maybe'?2:1);h.dispose()}})
test('explicit draw still runs downstream permissions; other tools bypass review',async()=>{const h=await harness(approve(1));h.session.deriveMessages=()=>[privateMsg];assert.equal((await h.run('qq_web_search')).kind,'allow');assert.equal(h.calls,0);assert.equal((await h.run()).kind,'allow');assert.equal(h.calls,1);h.dispose()})

test('quoted bot offer and punctuation alone do not authorize another picture',async()=>{const h=await harness(approve(1));h.session.deriveMessages=()=>[user('z','【私聊】甲：？？？ （引用 你 的消息：「画好了发你」）')];assert.equal((await h.run()).kind,'deny');assert.equal(h.calls,0);h.dispose()})
const action = user('g', '【群聊 测试】刚才新说的（1 条）\n[1] 甲(12345)@了你：画一只猫\n\n每行开头是说话人。')
const send = (h,uid,text) => h.receive({chatId:'group:123',userId:uid,text})
test('the same request cannot lend its decision to an unrelated drawing',async()=>{
 const h=await harness(body=>body.拟执行的绘图.prompt==='猫'?approve(1):deny('OTHER')); h.session.deriveMessages=()=>[action];
 assert.equal((await h.run(undefined,{prompt:'猫'})).kind,'allow');assert.equal((await h.run(undefined,{prompt:'飞机'})).kind,'deny');assert.equal(h.calls,2)
})
test('temporary failure can recover within the same user request',async()=>{
 const h=await harness((body,n)=>n===1?'':approve(1));h.session.deriveMessages=()=>[action];assert.equal((await h.run()).kind,'deny');assert.equal((await h.run()).kind,'allow')
})
test('clarification during review can stop, update or preserve an existing request; bystanders cannot cancel it',async()=>{
 for(const [who,text,expected,calls] of [['12345','先别画','deny',2],['12345','改成狗','deny',2],['12345','谢谢啦','allow',2],['77777','先别画','allow',1]]){
  const pause=Promise.withResolvers();const h=await harness(async(body,n)=>{if(n===1)await pause.promise;return body.同一请求者随后说?.some(s=>['先别画','改成狗'].includes(s))?deny('OTHER'):approve(1)});h.session.deriveMessages=()=>[action];const run=h.run();send(h,who,text);pause.resolve();assert.equal((await run).kind,expected);assert.equal(h.calls,calls);h.dispose()
 }
})
test('a newer admitted message or a stopped session cannot release an old approval',async()=>{
 for(const stop of [true,false]){const pause=Promise.withResolvers();const h=await harness(async()=>{await pause.promise;return approve(1)});h.session.deriveMessages=()=>[action];const controller=new AbortController();const run=h.run(undefined,{},controller.signal);if(stop)controller.abort();else h.session.deriveMessages=()=>[action,privateMsg];pause.resolve();assert.equal((await run).kind,stop?'cancel':'deny');assert.equal(h.passed,0)}
})

test('bystander suggesting a drawing cannot supply the direct requester’s excerpt',async()=>{
 const h=await harness(body=>{assert.deepEqual(body.请求者原话,[{id:1,text:'找个人物'}]);return approve(2)});h.session.deriveMessages=()=>[user('g','【群聊 测试】刚才新说的（2 条）\n[1] 甲(12345)@了你：找个人物\n[2] 乙(45678)：画只猫\n\n每行开头是说话人。')];assert.equal((await h.run()).kind,'deny');assert.equal(h.passed,0);h.dispose()
})

test('a mismatched reference is recoverable; extra explanation cannot turn a denial into an approval',async()=>{
 const h=await harness(body=>body.拟执行的绘图.image ? deny('REVISE') : approve(1))
 h.session.deriveMessages=()=>[action]
 const first=await h.run(undefined,{image:'msg:42:1',prompt:'修改群友发的飞机'})
 assert.equal(first.kind,'deny');assert.match(first.reason,/调整绘图参数/);assert.equal(h.passed,0)
 assert.equal((await h.run(undefined,{prompt:'橘猫立绘'})).kind,'allow');assert.equal(h.passed,1)
})


test('numbered references survive multiline text, quotes, escaping and spacing without copying the request', async () => {
 for (const original of ['画出来看下：\n真实照片质感，2K 超高清。', '画一只猫，牌子写"你好"。', '按 C:\\Pictures\\cat.png 的风格画', '画一下：\r\n\t猫咪\u3000开车']) {
  for (const inGroup of [false, true]) {
   const h = await harness(body => {
    assert.deepEqual(body.请求者原话, [{id:1,text:original}])
    return approve(1)
   })
   h.session.deriveMessages = () => [user('z', inGroup ? '【群聊 测试】刚才新说的（1 条）\n[1] 甲(12345)@了你：' + original + '\n\n每行开头是说话人。' : '【私聊】甲：' + original)]
   assert.equal((await h.run()).kind, 'allow'); assert.equal(h.passed, 1); assert.equal(h.calls, 1)
   h.dispose()
  }
 }
})

test('only valid supplied row ids approve; malformed or conflicting results stay closed', async () => {
 for (const response of [approve(0), approve(2), approve(-1), approve(1.5), approve(9007199254740993), approve(), 'DRAW 1', '{"decision":"DRAW","requestIds":[1]', '{"decision":"DRAW","requestIds":"1"}', approve(1) + deny('OTHER')]) {
  const h = await harness(response); h.session.deriveMessages = () => [action]
  assert.equal((await h.run()).kind, 'deny'); assert.equal(h.passed, 0); h.dispose()
 }
})

test('separate requester messages get stable ids; bystander and quoted text cannot gain ids', async () => {
 const h = await harness(body => {
  assert.deepEqual(body.请求者原话, [{id:1,text:'画只猫'}, {id:2,text:'背景留白'}])
  return approve(2)
 })
 h.session.deriveMessages = () => [user('z', '【群聊 测试】刚才新说的（3 条）\n[1] 甲(12345)@了你：画只猫 （引用 你 的消息：「我帮你画架飞机」）\n[2] 乙(45678)：画个机器人\n[3] 甲(12345)：背景留白\n\n每行开头是说话人。')]
 assert.equal((await h.run()).kind, 'allow'); assert.equal(h.passed, 1); h.dispose()
})

test('an image and a later drawing request can jointly authorize one operation', async () => {
 for (const ids of [[1,2], [2,1], [2], [1,2,2]]) {
  const h = await harness(body => {
   assert.deepEqual(body.请求者原话, [{id:1,text:'[图片]'}, {id:2,text:'是你吗这个？你画个你自己看下，对比一下。'}])
   return approve(...ids)
  })
  h.session.deriveMessages = () => [user('self', '【群聊 测试】刚才新说的（3 条）\n[1] 甲(12345)：[图片]\n[2] 乙(45678)：我的飞机\n[3] 甲(12345)@了你：是你吗这个？你画个你自己看下，对比一下。\n\n每行开头是说话人。')]
  assert.equal((await h.run(undefined,{prompt:'女性角色自画像'})).kind,'allow')
  assert.equal(h.passed,1); h.dispose()
 }
})

test('JSON transport supports any nonempty subset, formatting and explicit denials', () => {
 for (const ids of [[1], [1,2], [3,2,1], [4,2,3,1]]) {
  for (const text of [approve(...ids), JSON.stringify(JSON.parse(approve(...ids)),null,2), '```json\n'+approve(...ids)+'\n```']) {
   assert.deepEqual(parseDecision(text,4),{verdict:'DRAW'})
  }
 }
 for (const decision of ['OTHER','REVISE','UNCLEAR']) {
  assert.deepEqual(parseDecision(JSON.stringify({decision,requestIds:[1],explanation:'DRAW'}),1),{verdict:decision})
 }
 for (const text of ['null','[]','true','"DRAW"', '{}', '{"decision":"OTHER DRAW"}', '{"decision":"DRAW","requestIds":[true]}',
  '{"decision":"DRAW","requestIds":["1"]}', '{"decision":"DRAW","requestIds":[1,3]}',
  approve(1)+'\n不对，OTHER', '说明\n'+approve(1), '{"decision":"DRAW","requestIds":[1,]}']) {
  assert.ok(parseDecision(text,2).error,text)
 }
})

test('valid JSON cannot release a truncated or failed model response', async () => {
 for (const finish of ['length','error','tool-calls',undefined]) {
  const h = await harness(approve(1),finish === undefined ? '' : finish)
  h.session.deriveMessages = () => [action]
  assert.equal((await h.run()).kind,'deny'); assert.equal(h.passed,0); h.dispose()
 }
})

test('name wake uses admitted sender identity for both evidence and later amendments', async () => {
 for (const [who,expected,calls] of [['12345','deny',2],['77777','allow',1]]) {
  const pause = Promise.withResolvers(); const observed = []
  const h = await harness(async (body,n) => {
   observed.push(body.请求者原话)
   if (n===1) await pause.promise
   return body.同一请求者随后说?.length ? deny('OTHER') : approve(1)
  },'stop',['12345'])
  h.session.deriveMessages = () => [user('name','【群聊 测试】刚才新说的（2 条）\n[1] 乙(77777)：我要画飞机\n[2] 甲(12345)：心软，画只猫\n\n每行开头是说话人。')]
  const run = h.run(undefined,{prompt:'猫'})
  send(h,who,'先别画了'); pause.resolve()
  assert.equal((await run).kind,expected); assert.equal(h.calls,calls)
  for (const rows of observed) assert.deepEqual(rows,[{id:1,text:'心软，画只猫'}])
  h.dispose()
 }
})

test('sender identity works for arbitrary wake names and QQ replies without text matching', async () => {
 for (const text of ['心软，画只猫','不再心软，画只猫','我新设的唤醒词，画只猫','换成蓝色 （引用 你 的消息：「猫图画好了」）']) {
  let evidence
  const h = await harness(body => { evidence=body.请求者原话; return approve(1) },'stop',['12345'])
  h.session.deriveMessages = () => [user('wake','【群聊 测试】刚才新说的（2 条）\n[1] 乙(77777)：画飞机\n[2] 甲(12345)：'+text+'\n\n每行开头是说话人。')]
  assert.equal((await h.run()).kind,'allow')
  assert.deepEqual(evidence,[{id:1,text:text.split(' （引用')[0]}]); h.dispose()
 }
})

test('ambiguous or absent admitted senders do not invent a requester; visible mentions still work', async () => {
 for (const senders of [undefined,[],['99999'],['12345','77777']]) {
  const observed=[]
  const h = await harness(body => { observed.push(body.请求者原话); return approve(1) },'stop',senders)
  const text='【群聊 测试】刚才新说的（2 条）\n[1] 乙(77777)：画飞机\n[2] 甲(12345)：心软，画只猫\n\n每行开头是说话人。'
  h.session.deriveMessages = () => [user('a',text)]
  assert.equal((await h.run()).kind,'allow')
  assert.equal(observed[0].length,2)
  h.session.deriveMessages = () => [user('b',text.replace('甲(12345)：','甲(12345)@了你：'))]
  assert.equal((await h.run()).kind,'allow')
  assert.deepEqual(observed[1],[{id:1,text:'心软，画只猫'}]); h.dispose()
 }
})

test('queued senders cannot change the requester of an already captured input', async () => {
 const senders=['12345']; const seen=[]; const pause=Promise.withResolvers()
 const h=await harness(async (body,n) => {
  seen.push(body)
  if(n===2) await pause.promise
  return body.同一请求者随后说.length ? deny('OTHER') : approve(1)
 },'stop',senders)
 h.session.deriveMessages=()=>[user('a','【群聊 测试】刚才新说的（1 条）\n[1] 甲(12345)：心软，画两只猫\n\n每行开头是说话人。')]
 assert.equal((await h.run(undefined,{prompt:'第一只猫'})).kind,'allow')
 senders.push('77777')
 const run=h.run(undefined,{prompt:'第二只猫'}); send(h,'12345','后面别画了'); pause.resolve()
 assert.equal((await run).kind,'deny'); assert.equal(h.passed,1); assert.equal(seen.length,3)
 h.dispose()
})

test('parallel tool checks with separate cancellation signals do not cancel each other', async () => {
 const pause=Promise.withResolvers()
 const h=await harness(async()=>{await pause.promise; return approve(1)})
 h.session.deriveMessages=()=>[action]
 const a=new AbortController(), b=new AbortController()
 const one=h.run(undefined,{prompt:'猫'},a.signal), two=h.run(undefined,{prompt:'猫'},b.signal)
 a.abort();pause.resolve()
 assert.equal((await one).kind,'cancel');assert.equal((await two).kind,'allow')
 assert.equal(h.passed,1);h.dispose()
})

test('unloading the module cancels a pending approval, and another chat cannot amend it', async () => {
 for (const unload of [false,true]) {
  const pause=Promise.withResolvers()
  const h=await harness(async()=>{await pause.promise;return approve(1)})
  h.session.deriveMessages=()=>[action]
  const run=h.run()
  h.receive({chatId:'group:other',userId:'12345',text:'先别画了'})
  if(unload)h.dispose()
  pause.resolve()
  assert.equal((await run).kind,unload?'cancel':'allow');assert.equal(h.calls,1)
  if(!unload)h.dispose()
 }
})
