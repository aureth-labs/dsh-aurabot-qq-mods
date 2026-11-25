import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { EventEmitter } from 'node:events'
import { createDesktop, characterFor, desktopSettings } from '../lib/desktop.mjs'

function harness(patch = {}) {
  const root = mkdtempSync(join(tmpdir(), 'bond-desktop-'))
  const dataDir = join(root,'data'); mkdirSync(dataDir)
  const moduleDir = join(root,'module')
  const exe = join(moduleDir,'assets/desktop/macos-arm64/CompanionBond.app/Contents/MacOS/CompanionBond')
  mkdirSync(join(exe,'..'),{recursive:true}); writeFileSync(exe,'test binary')
  const cfg = { desktopEnabled:true, desktopHeight:300, desktopPreviewStage:'auto' }
  const growth = { bond:80, xp:80 }
  const calls = [], children = [], warnings = []
  let time=Date.now()
  const desktop = createDesktop({ moduleDir,dataDir,getSettings:()=>cfg,getState:()=>growth,
    saveSettings:p=>Object.assign(cfg,p),log:{warn:s=>warnings.push(s)},platform:'darwin',arch:'arm64',now:()=>time,
    spawnFn:(file,args,opts)=>{ calls.push({file,args,opts}); const child=new EventEmitter();child.killed=false;child.kill=()=>{child.killed=true};children.push(child);return child },...patch })
  return { cfg,growth,calls,children,warnings,desktop,dataDir,moduleDir, tick(ms=2000){ time+=ms;desktop.sync() },
    bridge:()=>JSON.parse(readFileSync(join(dataDir,'desktop-state.json'),'utf8')),
    close(){ desktop.dispose(); rmSync(root,{recursive:true,force:true}) } }
}

test('三档严格按用户指定顺序与亲密度边界对应',()=>{
  assert.equal(characterFor(0),'low');assert.equal(characterFor(99),'low')
  assert.equal(characterFor(100),'middle');assert.equal(characterFor(599),'middle')
  assert.equal(characterFor(600),'high');assert.equal(characterFor(1000),'high')
})
test('大小与外观输入有界，缺省开启，非法预览回到自动',()=>{
  assert.equal(desktopSettings().desktopEnabled,true)
  assert.equal(desktopSettings({desktopHeight:0}).desktopHeight,140)
  assert.equal(desktopSettings({desktopHeight:9999}).desktopHeight,600)
  assert.equal(desktopSettings({desktopPreviewStage:'../../x'}).desktopPreviewStage,'auto')
})
test('仅启动自己的本地程序，重复同步不重复创建窗口',()=>{
  const h=harness();try{
    h.tick();h.tick();h.tick();assert.equal(h.calls.length,1)
    assert.equal(h.calls[0].file,'/usr/bin/open')
    assert.deepEqual(h.calls[0].args.slice(0,3),['-W','-n','-a'])
    assert.match(h.calls[0].args[3],/CompanionBond\.app$/)
    assert.equal(h.calls[0].args[4],'--args')
    assert.match(h.calls[0].args[5],/desktop-state\.json$/)
    assert.equal(h.bridge().stage,'low')
  }finally{h.close()}
})
test('亲密度变化换图，不重启程序，不改原养成状态',()=>{
  const h=harness();try{
    h.tick();h.growth.bond=100;h.tick();assert.equal(h.bridge().stage,'middle')
    h.growth.bond=600;h.tick();assert.equal(h.bridge().stage,'high')
    assert.equal(h.calls.length,1);assert.equal(h.growth.xp,80)
  }finally{h.close()}
})
test('预览高级只换显示，再切自动恢复真实低级',()=>{
  const h=harness();try{
    h.cfg.desktopPreviewStage='high';h.tick();assert.equal(h.bridge().stage,'high')
    assert.equal(h.bridge().preview,true);assert.equal(h.growth.bond,80)
    h.cfg.desktopPreviewStage='auto';h.tick();assert.equal(h.bridge().stage,'low')
  }finally{h.close()}
})
test('关闭立即停止子进程，重新开启可再次启动',()=>{
  const h=harness();try{
    h.tick();h.cfg.desktopEnabled=false;h.tick();assert.equal(h.children[0].killed,true)
    assert.equal(h.bridge().enabled,false)
    h.cfg.desktopEnabled=true;h.tick(10000);assert.equal(h.calls.length,2)
  }finally{h.close()}
})
test('当前窗口请求可隐藏；旧实例请求不生效',()=>{
  const h=harness();try{
    h.tick()
    const file=join(h.dataDir,'desktop-request.json')
    writeFileSync(file,JSON.stringify({session:'old',action:'hide'}));h.tick();assert.equal(h.cfg.desktopEnabled,true)
    writeFileSync(file,JSON.stringify({session:h.bridge().session,action:'hide'}));h.tick()
    assert.equal(h.cfg.desktopEnabled,false);assert.equal(h.children[0].killed,true)
    assert.equal(existsSync(file),false)
  }finally{h.close()}
})
test('停用模块会停止自己的子进程，之后不再启动',()=>{
  const h=harness();try{
    h.tick();h.desktop.dispose();assert.equal(h.children[0].killed,true)
    h.tick(20000);assert.equal(h.calls.length,1);assert.equal(h.bridge().enabled,false)
  }finally{h.close()}
})
test('非 Mac 不启动桌面进程，状态如实标记不支持',()=>{
  const h=harness({platform:'win32'});try{
    h.tick();assert.equal(h.calls.length,0);assert.equal(h.desktop.info().supported,false)
  }finally{h.close()}
})
test('启动错误不会抛给聊天循环，且有重试冷却',()=>{
  const h=harness({spawnFn:()=>{throw Error('test launch failed')}});try{
    assert.doesNotThrow(()=>h.tick());assert.match(h.desktop.info().error,/test launch failed/)
    h.tick();assert.equal(h.warnings.length,1)
  }finally{h.close()}
})


test('Q 版待机默认开启，可独立暂停，原养成状态不变',()=>{
  const h=harness();try{
    h.tick();assert.equal(h.bridge().idleEnabled,true)
    const growth=JSON.stringify(h.growth)
    h.cfg.desktopIdleEnabled=false;h.tick();assert.equal(h.bridge().idleEnabled,false)
    assert.equal(h.cfg.desktopEnabled,true)
    const file=join(h.dataDir,'desktop-request.json')
    writeFileSync(file,JSON.stringify({session:h.bridge().session,action:'idle',enabled:true}));h.tick()
    assert.equal(h.cfg.desktopIdleEnabled,true)
    writeFileSync(file,JSON.stringify({session:h.bridge().session,action:'idle',enabled:'bad'}));h.tick()
    assert.equal(h.cfg.desktopIdleEnabled,true)
    assert.equal(JSON.stringify(h.growth),growth)
  }finally{h.close()}
})


test('中级使用独立闭眼素材，切换外观不修改真实成长',()=>{
  const h=harness();try{
    h.tick();assert.match(h.bridge().idleBlinkPath,/idle-low-closed.png$/)
    const before=JSON.stringify(h.growth)
    h.cfg.desktopPreviewStage='middle';h.tick()
    assert.equal(h.bridge().stage,'middle');assert.match(h.bridge().idleBlinkPath,/idle-middle-closed.png$/)
    h.cfg.desktopPreviewStage='auto';h.tick();assert.equal(h.bridge().stage,'low')
    assert.equal(JSON.stringify(h.growth),before)
  }finally{h.close()}
})

test('最高级使用自己的闭眼素材，预览不增加亲密度',()=>{
  const h=harness();try{
    h.tick();const before=JSON.stringify(h.growth)
    h.cfg.desktopPreviewStage='high';h.tick()
    assert.equal(h.bridge().stage,'high');assert.match(h.bridge().idleBlinkPath,/idle-high-closed.png$/)
    h.cfg.desktopPreviewStage='middle';h.tick();assert.match(h.bridge().idleBlinkPath,/idle-middle-closed.png$/)
    assert.equal(JSON.stringify(h.growth),before)
  }finally{h.close()}
})
