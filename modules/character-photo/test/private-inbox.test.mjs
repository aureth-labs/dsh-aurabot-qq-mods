import test from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, symlinkSync, unlinkSync, renameSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { basename, join } from 'node:path'
import { tmpdir } from 'node:os'
import { createServer } from 'node:http'
import { once } from 'node:events'
import { spawnSync } from 'node:child_process'
import { registerInbox, inboxDefaults, inboxSettings } from '../lib/private-inbox.mjs'
import { DEFAULTS,settings as validate } from '../lib/director.mjs'

function fixture(t, oldRunning=false, oldSettings,existing={}) {
  const root=mkdtempSync(join(tmpdir(),'qq-inbox-'))
  t.after(()=>rmSync(root,{recursive:true,force:true}))
  const dir=join(root,'character-photo'), source=join(root,'gateway')
  mkdirSync(dir);mkdirSync(source)
  const ext={'character-photo':{...structuredClone(DEFAULTS),enabled:true,...existing},'file-inbox':oldSettings}
  const handlers={},routes={},builders=[],sent=[],uploads=[],replies=[]
  const owner={kind:'private',userId:'10001',chatId:'private:10001'}
  const api={
    settings:()=>ext['character-photo'],saveSettings:patch=>Object.assign(ext['character-photo'],patch),
    config:()=>({ownerQQ:owner.userId,ext}),has:()=>oldRunning,dataDir:(...parts)=>join(dir,...parts),log:{info(){}},
    on:(event,fn)=>{handlers[event]=fn},tool:fn=>builders.push(fn),defineTool:spec=>spec,rule(){},
    core:{http:{query:req=>req.query},local:{active:()=>false}},route:(path,fn,options)=>{assert.equal(options.access,'panel');routes[path]=fn},
    reply:async(_,value)=>replies.push(value),sendSegments:async(...args)=>{sent.push(args);return {message_id:1}},
    onebot:async(name,data)=>{if(name==='get_file')return {file:join(source,data.file_id)};if(name==='upload_private_file')uploads.push(data);return {}}
  }
  registerInbox(api)
  const tools=(chat=owner)=>Object.fromEntries(builders.flatMap(build=>build({chat})).map(tool=>[tool.name,tool]))
  let id=0
  const receive=(name,options={})=>handlers.message({...owner,...options.chat,raw:{message_id:++id,...options.raw,message:[{type:'file',data:{file_name:name,id:name,...options.segment}}]}})
  const file=(name,body)=>writeFileSync(join(source,name),body)
  const state=()=>routes['/inbox']()
  const configure=patch=>api.saveSettings({privateInbox:inboxSettings({...inboxDefaults,...api.settings().privateInbox,...patch})})
  return {api,tools,owner,old:value=>{oldRunning=value},receive,file,state,configure,sent,uploads,replies,routes,dir,root}
}

test('host default initialization preserves original six settings and explicit integrated settings',async t=>{
  const defaults=fixture(t,false)
  assert.deepEqual((await defaults.state()).settings,inboxDefaults)
  const chosen={...inboxDefaults,scope:'owner',ownerQQ:'90001',exts:'pdf',autoReply:false}
  const existing=fixture(t,false,{...inboxDefaults,scope:'all',exts:'zip'},{privateInbox:chosen})
  assert.deepEqual((await existing.state()).settings,chosen)
})
test('original six settings, fresh inbox and both legacy load orders',async t=>{
  for(const loaded of [true,false]){
    const f=fixture(t,loaded,{scope:'all',maxMB:9,ownerQQ:'10001',autoReply:false,exts:'txt',ffmpegPath:''})
    const oldDir=join(f.root,'file-inbox','inbox')
    mkdirSync(oldDir,{recursive:true});writeFileSync(join(oldDir,'inbox.json'),'[{"name":"old"}]')
    const state=await f.state()
    assert.equal(state.settings.maxMB,9);assert.equal(state.total,0);assert.equal(state.settings.autoReply,false)
    f.old(true);f.file('sample.txt','独立模块运行中')
    assert.deepEqual(f.tools(),{});await f.receive('sample.txt')
    assert.equal((await f.state()).total,0)
    f.old(false);const tools=f.tools()
    assert.deepEqual(Object.keys(tools),['inbox_files','inbox_send'])
    await f.receive('sample.txt');assert.equal((await f.state()).total,1);assert.equal(f.replies.length,0)
    f.old(true);assert.equal((await tools.inbox_files.execute({})).ok,false)
    assert.deepEqual(JSON.parse(readFileSync(join(oldDir,'inbox.json'))),[{name:'old'}])
  }
  assert.throws(()=>validate({privateInbox:{...inboxDefaults,maxMB:0}}),/2048/)
  assert.throws(()=>inboxSettings({...inboxDefaults,ownerQQ:'!'}),/QQ/)
})
test('QQ segment filter, scope, actual attachment bytes, same-name arrivals and repeat delivery',async t=>{
  const f=fixture(t)
  f.file('one.txt','第一份');f.file('two.txt','第二份')
  const opts={raw:{message_id:91},segment:{file_name:'同名.txt'}}
  await f.receive('one.txt',{chat:{kind:'group'}});await f.receive('one.txt',{chat:{userId:'20002'}})
  await f.receive('one.txt',{raw:{simulated:true}})
  assert.equal((await f.state()).total,0)
  await Promise.all([f.receive('one.txt',opts),f.receive('one.txt',opts),f.receive('two.txt',{raw:{message_id:92},segment:{file_name:'同名.txt'}})])
  await f.receive('one.txt',opts)
  const state=await f.state()
  assert.equal(state.total,2);assert.equal(f.replies.length,2)
  assert.deepEqual(state.items.map(x=>readFileSync(x.path,'utf8')).sort(),['第一份','第二份'].sort())
  assert.match((await f.tools().inbox_files.execute({read:1})).message,/第[一二]份/)
  f.configure({scope:'all',maxMB:1,exts:'txt'})
  await f.receive('one.txt',{chat:{userId:'20002'}})
  assert.deepEqual(f.tools({kind:'private',userId:'20002',chatId:'private:20002'}),{})
  assert.deepEqual(f.tools({kind:'group',userId:'10001',chatId:'group:1'}),{})
  await f.receive('skip.pdf');await f.receive('large.txt',{segment:{file_size:2000000}})
  f.file('unknown-size.txt',Buffer.alloc(1024*1024+1));await f.receive('unknown-size.txt')
  assert.deepEqual((await f.state()).records.slice(0,3).map(r=>r.action),['失败','跳过','跳过'])
  assert.equal((await f.state()).total,3)
  assert.equal(readdirSync(join(f.dir,'inbox')).length,5)
})
test('reads ZIP contents and three Office formats, handles PDF, ASR and original QQ delivery methods',async t=>{
  const f=fixture(t),body=Buffer.from('UEsDBBQAAAAIAOSgel3cqiRMIQAAACIAAAARAAAAd29yZC9kb2N1bWVudC54bWyzKbcqsLMptyqxe7Z28bNp7c8WbH82Z42NPkgERBbYAQBQSwMEFAAAAAgA5KB6XYSXRNMkAAAAJQAAABUAAABwcHQvc2xpZGVzL3NsaWRlMS54bWyzSbQqsLNJtCqxe9Y19enejc87258t2P5szhobfZAgiCywAwBQSwMEFAAAAAgA5KB6XVMafk47AAAAPAAAABgAAAB4bC93b3Jrc2hlZXRzL3NoZWV0MS54bWyzKcovt7NJViixVcrMy8nMSw0uKVKys8kstrMpsXuxcMWzBXueLdj+bM4aG/0SOxt9kLh+sp2NPkgbAFBLAQIUABQAAAAIAOSgel3cqiRMIQAAACIAAAARAAAAAAAAAAAAAACAAQAAAAB3b3JkL2RvY3VtZW50LnhtbFBLAQIUABQAAAAIAOSgel2El0TTJAAAACUAAAAVAAAAAAAAAAAAAACAAVAAAABwcHQvc2xpZGVzL3NsaWRlMS54bWxQSwECFAAUAAAACADkoHpdUxp+TjsAAAA8AAAAGAAAAAAAAAAAAAAAgAGnAAAAeGwvd29ya3NoZWV0cy9zaGVldDEueG1sUEsFBgAAAAADAAMAyAAAABgBAAAAAA==','base64')
  const {inbox_files,inbox_send}=f.tools()
  for(const [name,contains] of [['bundle.zip','word/document.xml'],['a.docx','正文样本'],['b.pptx','投影片样本'],['c.xlsx','表格样本'],['d.pdf','PDF 文字提取']]){
    f.file(name,body);await f.receive(name)
    assert.match((await inbox_files.execute({read:1})).message,new RegExp(contains))
    assert.equal((await inbox_send.execute({no:1})).ok,true)
    assert.equal(f.uploads.at(-1).name,name);assert.equal(f.uploads.at(-1).user_id,10001)
  }
  for(const [name,type] of [['pic.png','image'],['sound.wav','record'],['video.mp4','video']]){
    f.file(name,Buffer.alloc(50));await f.receive(name)
    if(type==='record')assert.match((await inbox_files.execute({read:1})).message,/ASR/)
    assert.equal((await inbox_send.execute({no:1})).ok,true)
    assert.equal(f.sent.at(-1)[0],f.owner.chatId);assert.equal(f.sent.at(-1)[1][0].type,type)
  }
  f.api.sendSegments=async()=>null
  assert.equal((await inbox_send.execute({no:1})).ok,false)
})
test('direct URL and get_private_file_url download and panel preview return the original bytes',async t=>{
  const f=fixture(t),body=Buffer.from('QQ attachment sample')
  const server=createServer((req,res)=>{if(req.url==='/source')res.end(body);else f.routes['/inbox/file']({query:{id:new URL(req.url,'http://localhost').searchParams.get('id'),download:true}},res).catch(error=>res.destroy(error))})
  server.listen(0,'127.0.0.1');await once(server,'listening')
  t.after(()=>new Promise(resolve=>server.close(resolve)))
  const url='http://127.0.0.1:'+server.address().port
  await f.receive('direct.txt',{segment:{url:url+'/source'}})
  f.api.onebot=async name=>{assert.equal(name,'get_private_file_url');return {url:url+'/source'}}
  await f.receive('fallback.txt')
  const state=await f.state();assert.equal(state.total,2)
  for(const row of state.items){
    const r=await fetch(url+'/preview?id='+encodeURIComponent(row.id))
    assert.match(r.headers.get('content-disposition'),/attachment/);assert.deepEqual(Buffer.from(await r.arrayBuffer()),body)
  }
})
test('retains 50 originals and the independent receipt history',async t=>{
  const f=fixture(t);f.file('repeat.txt','sample');f.configure({autoReply:false})
  for(let i=0;i<53;i++)await f.receive('repeat.txt')
  const state=await f.state()
  assert.equal(state.items.length,50);assert.equal(state.records.length,53);assert.equal(readdirSync(join(f.dir,'inbox')).length,52)
})

test('converts received WAV through installed ffmpeg and requests the local ASR adapter',async t=>{
  if(spawnSync('ffmpeg',['-version'],{windowsHide:true,stdio:'ignore'}).status!==0){t.skip('ffmpeg absent');return}
  const f=fixture(t),wav=Buffer.alloc(44+3200)
  wav.write('RIFF');wav.writeUInt32LE(wav.length-8,4);wav.write('WAVEfmt ',8)
  wav.writeUInt32LE(16,16);wav.writeUInt16LE(1,20);wav.writeUInt16LE(1,22)
  wav.writeUInt32LE(16000,24);wav.writeUInt32LE(32000,28);wav.writeUInt16LE(2,32);wav.writeUInt16LE(16,34)
  wav.write('data',36);wav.writeUInt32LE(3200,40)
  let calls=0
  f.api.core.local={active:kind=>kind==='asr',call:async(kind,{file})=>{
    assert.equal(kind,'asr');assert.equal(readFileSync(file).toString('ascii',0,4),'RIFF');calls++
    return {text:'适配器回执'}
  }}
  f.file('source.wav',wav);await f.receive('source.wav')
  for(let i=0;i<2;i++)assert.match((await f.tools().inbox_files.execute({read:1})).message,/适配器回执/)
  assert.equal(calls,1)
})

test('local open or index failure preserves committed records, cleans partials and allows a retry',async t=>{
  const f=fixture(t);f.file('first.txt','keep');await f.receive('first.txt')
  const inbox=join(f.dir,'inbox'),first=(await f.state()).items[0]
  f.file('second.txt','retry')
  mkdirSync(join(inbox,'inbox.json.tmp'))
  const item={raw:{message_id:580}}
  await f.receive('second.txt',item)
  assert.equal((await f.state()).total,1)
  assert.equal((await f.state()).records[0].action,'失败')
  assert.equal(readdirSync(inbox).filter(n=>n.startsWith('qq-inbox-')).length,1)
  rmSync(join(inbox,'inbox.json.tmp'),{recursive:true})
  await f.receive('second.txt',item)
  assert.equal((await f.state()).total,2)
  assert.equal(readFileSync(first.path,'utf8'),'keep')
  f.api.onebot=async action=>{if(action==='upload_private_file')throw Error('网关拒绝附件')}
  const bounced=await f.tools().inbox_send.execute({no:1})
  assert.equal(bounced.ok,false);assert.match(bounced.message,/网关拒绝附件/)
  assert.equal((await f.state()).total,2)
})
test('reload recovers a committed temporary index and removes only abandoned QQ originals',async t=>{
  const f=fixture(t);f.file('kept.txt','original');await f.receive('kept.txt')
  const inbox=join(f.dir,'inbox'),old=(await f.state()).items[0]
  const orphan=join(inbox,'qq-inbox-00000000-0000-4000-8000-000000000001-untitled')
  writeFileSync(orphan,'partial')
  writeFileSync(join(inbox,'manual.txt'),'keep')
  renameSync(join(inbox,'inbox.json'),join(inbox,'inbox.json.tmp'))
  registerInbox(f.api)
  assert.equal((await f.state()).total,1)
  assert.equal(readFileSync(old.path,'utf8'),'original')
  assert.ok(!existsSync(orphan))
  assert.equal(readFileSync(join(inbox,'manual.txt'),'utf8'),'keep')
  writeFileSync(join(inbox,'inbox.json'),'{')
  writeFileSync(orphan,'may still be referenced')
  registerInbox(f.api)
  assert.equal(readFileSync(orphan,'utf8'),'may still be referenced')
})

test('damaged indexes cannot expose or prune a file outside the new inbox',async t=>{
  const f=fixture(t),inbox=join(f.dir,'inbox'),index=join(inbox,'inbox.json')
  f.file('marker.txt','ordinary receipt');await f.receive('marker.txt')
  const original=(await f.state()).items[0],outside=join(f.root,basename(original.path))
  writeFileSync(outside,'external marker')
  const wrongName=join(inbox,'manual.txt')
  writeFileSync(wrongName,'unmanaged file')
  const {inbox_files,inbox_send}=f.tools()
  for(const path of [outside,wrongName]){
    const forged={...original,path,id:'bad'}
    const contents=JSON.stringify([...Array(50).fill(original),forged])
    writeFileSync(index,contents)
    await assert.rejects(inbox_files.execute({read:51}),/路径无效/)
    await assert.rejects(inbox_send.execute({no:51}),/路径无效/)
    await assert.rejects(f.routes['/inbox/file']({query:{id:'bad'}},{}),/路径无效/)
    await assert.rejects(f.receive('marker.txt'),/路径无效/)
    registerInbox(f.api)
    assert.equal(readFileSync(index,'utf8'),contents)
    assert.equal(readFileSync(outside,'utf8'),'external marker')
    assert.equal(readFileSync(wrongName,'utf8'),'unmanaged file')
    assert.equal(f.uploads.length,0)
  }
})
test('linked originals or linked inbox directory are refused before tools, streaming or eviction',async t=>{
  const f=fixture(t),inbox=join(f.dir,'inbox'),index=join(inbox,'inbox.json')
  f.file('marker.txt','original');await f.receive('marker.txt')
  const original=(await f.state()).items[0],outside=join(f.root,'external-marker.txt')
  writeFileSync(outside,'external marker')
  unlinkSync(original.path)
  symlinkSync(outside,original.path,'file')
  const contents=readFileSync(index,'utf8')
  await assert.rejects(f.tools().inbox_files.execute({read:1}),/链接/)
  await assert.rejects(f.tools().inbox_send.execute({no:1}),/链接/)
  await assert.rejects(f.routes['/inbox/file']({query:{id:original.id}},{}),/链接/)
  await assert.rejects(f.receive('marker.txt'),/链接/)
  registerInbox(f.api)
  assert.equal(readFileSync(index,'utf8'),contents)
  assert.equal(readFileSync(outside,'utf8'),'external marker')
  const moved=join(f.root,'moved')
  renameSync(inbox,moved)
  symlinkSync(moved,inbox,'junction')
  await assert.rejects(f.state(),/独立目录/)
  await assert.rejects(f.receive('marker.txt'),/独立目录/)
  assert.equal(readFileSync(join(moved,'inbox.json'),'utf8'),contents)
})
