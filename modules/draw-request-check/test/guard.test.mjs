import test from 'node:test'
import assert from 'node:assert/strict'
import guard, {requestOf} from '../index.mjs'
const user = (id, text) => ({role:'user',id,source:{kind:'aurabot'},content:[{type:'text',text}]})
const group = user('a','【群聊 测试】之前在聊：\n甲：画一张\n\n【群聊 测试】刚才新说的（1 条）\n[1] 乙(12345)@了你：查人物\n\n每行开头是说话人。')
const privateMsg = user('b','【私聊】甲：换成蓝色')
const runtime = {role:'user',source:{kind:'runtime-context'},content:[{type:'text',text:'绘图规则'}]}
test('only current chat input and adjacent exchange can support a draw',()=>{
 const messages=[group,{role:'assistant',content:[{type:'text',text:'有这些人物。'}]},privateMsg,runtime,{role:'user',source:{kind:'repeat-tool-reminder',form:'notice'},content:[]},{role:'tool',content:[]},{role:'assistant',content:[{type:'text',text:'我还可以画图。'}]}];
 assert.deepEqual(requestOf(messages),{id:'b',current:'【私聊】甲：换成蓝色',previous:'[1] 乙(12345)@了你：查人物',reply:'有这些人物。'});
 assert.equal(requestOf([...messages,user('scheduled','系统任务')]),null)
})
async function harness(response){
 let hook,receive,calls=0,passed=0;const session={id:'s',deriveMessages:()=>[group]};let dispose;
 const api={on:(event,h)=>{assert.equal(event,'message');receive=h},dsh:{on:(event,h)=>{assert.equal(event,'tools/pre-execute');hook=h;return ()=>{}},llm:{async *stream(req){calls++;assert.equal(req.tools.length,0);yield {type:'text-delta',text:typeof response === 'function' ? await response(JSON.parse(req.messages[0].content[0].text),calls) : response};yield {type:'finish',reason:{kind:'stop'}}}}},core:{hub:{modelFor:()=>({provider:'test',model:'test'}),chatOfSession:()=> 'group:123'}},onDispose:f=>dispose=f};guard.setup(api);
 const run=(name='qq_draw_image',args={},signal=new AbortController().signal)=>hook({name,arguments:args,agent:{session},signal},()=>{passed++;return {kind:'allow'}});return {run,receive,get calls(){return calls},get passed(){return passed},dispose,session}
}
test('lookup and uncertain/invalid decisions cannot start generation or its slow notice',async()=>{for(const v of ['OTHER','UNCLEAR','maybe']){const h=await harness(v);assert.equal((await h.run()).kind,'deny');assert.equal(h.passed,0);await h.run();assert.equal(h.calls,v==='maybe'?2:1);h.dispose()}})
test('explicit draw still runs downstream permissions; other tools bypass review',async()=>{const h=await harness('DRAW 1');h.session.deriveMessages=()=>[privateMsg];assert.equal((await h.run('qq_web_search')).kind,'allow');assert.equal(h.calls,0);assert.equal((await h.run()).kind,'allow');assert.equal(h.calls,1);h.dispose()})

test('quoted bot offer and punctuation alone do not authorize another picture',async()=>{const h=await harness('DRAW 1');h.session.deriveMessages=()=>[user('z','【私聊】甲：？？？ （引用 你 的消息：「画好了发你」）')];assert.equal((await h.run()).kind,'deny');assert.equal(h.calls,0);h.dispose()})
const action = user('g', '【群聊 测试】刚才新说的（1 条）\n[1] 甲(12345)@了你：画一只猫\n\n每行开头是说话人。')
const send = (h,uid,text) => h.receive({chatId:'group:123',userId:uid,text})
test('the same request cannot lend its decision to an unrelated drawing',async()=>{
 const h=await harness(body=>body.拟执行的绘图.prompt==='猫'?'DRAW 1':'OTHER'); h.session.deriveMessages=()=>[action];
 assert.equal((await h.run(undefined,{prompt:'猫'})).kind,'allow');assert.equal((await h.run(undefined,{prompt:'飞机'})).kind,'deny');assert.equal(h.calls,2)
})
test('temporary failure can recover within the same user request',async()=>{
 const h=await harness((body,n)=>n===1?'':'DRAW 1');h.session.deriveMessages=()=>[action];assert.equal((await h.run()).kind,'deny');assert.equal((await h.run()).kind,'allow')
})
test('clarification during review can stop, update or preserve an existing request; bystanders cannot cancel it',async()=>{
 for(const [who,text,expected,calls] of [['12345','先别画','deny',2],['12345','改成狗','deny',2],['12345','谢谢啦','allow',2],['77777','先别画','allow',1]]){
  const pause=Promise.withResolvers();const h=await harness(async(body,n)=>{if(n===1)await pause.promise;return body.同一请求者随后说?.some(s=>['先别画','改成狗'].includes(s))?'OTHER':'DRAW 1'});h.session.deriveMessages=()=>[action];const run=h.run();send(h,who,text);pause.resolve();assert.equal((await run).kind,expected);assert.equal(h.calls,calls);h.dispose()
 }
})
test('a newer admitted message or a stopped session cannot release an old approval',async()=>{
 for(const stop of [true,false]){const pause=Promise.withResolvers();const h=await harness(async()=>{await pause.promise;return 'DRAW 1'});h.session.deriveMessages=()=>[action];const controller=new AbortController();const run=h.run(undefined,{},controller.signal);if(stop)controller.abort();else h.session.deriveMessages=()=>[action,privateMsg];pause.resolve();assert.equal((await run).kind,stop?'cancel':'deny');assert.equal(h.passed,0)}
})

test('bystander suggesting a drawing cannot supply the direct requester’s excerpt',async()=>{
 const h=await harness(body=>{assert.deepEqual(body.请求者原话,[{id:1,text:'找个人物'}]);return 'DRAW 2'});h.session.deriveMessages=()=>[user('g','【群聊 测试】刚才新说的（2 条）\n[1] 甲(12345)@了你：找个人物\n[2] 乙(45678)：画只猫\n\n每行开头是说话人。')];assert.equal((await h.run()).kind,'deny');assert.equal(h.passed,0);h.dispose()
})

test('a mismatched reference is recoverable; extra explanation cannot turn a denial into an approval',async()=>{
 const h=await harness(body=>body.拟执行的绘图.image ? 'REVISE\n用户要新画，没有说参考这张群聊图片。' : 'DRAW 1')
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
    return 'DRAW 1'
   })
   h.session.deriveMessages = () => [user('z', inGroup ? '【群聊 测试】刚才新说的（1 条）\n[1] 甲(12345)@了你：' + original + '\n\n每行开头是说话人。' : '【私聊】甲：' + original)]
   assert.equal((await h.run()).kind, 'allow'); assert.equal(h.passed, 1); assert.equal(h.calls, 1)
   h.dispose()
  }
 }
})

test('only a valid supplied row id can approve; malformed responses and denials stay closed', async () => {
 for (const response of ['DRAW 0', 'DRAW 2', 'DRAW -1', 'DRAW 1.5', 'DRAW 9007199254740993', 'DRAW', 'DRAW 画一只猫', 'DRAW 1 可以画', 'OTHER\nDRAW 1']) {
  const h = await harness(response); h.session.deriveMessages = () => [action]
  assert.equal((await h.run()).kind, 'deny'); assert.equal(h.passed, 0); h.dispose()
 }
})

test('separate requester messages get stable ids; bystander and quoted text cannot gain ids', async () => {
 const h = await harness(body => {
  assert.deepEqual(body.请求者原话, [{id:1,text:'画只猫'}, {id:2,text:'背景留白'}])
  return 'DRAW 2'
 })
 h.session.deriveMessages = () => [user('z', '【群聊 测试】刚才新说的（3 条）\n[1] 甲(12345)@了你：画只猫 （引用 你 的消息：「我帮你画架飞机」）\n[2] 乙(45678)：画个机器人\n[3] 甲(12345)：背景留白\n\n每行开头是说话人。')]
 assert.equal((await h.run()).kind, 'allow'); assert.equal(h.passed, 1); h.dispose()
})
