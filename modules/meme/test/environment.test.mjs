import test from 'node:test';
import assert from 'node:assert/strict';
import { checkEnvironment, EnvironmentError, environmentMessage } from '../lib/environment.mjs';
import { publicErrorMessage } from '../lib/errors.mjs';
import { BootstrapManager } from '../lib/bootstrap.mjs';
import { ExtensionManager } from '../lib/extension.mjs';
import { tmpdir } from 'node:os';
const linux={platform:'linux',arch:'x64',glibc:'2.36',osRelease:'ID=debian\n',hasLibrary:async()=>true};
test('五个平台自动选择；Windows/macOS 不检查 Linux 系统库',async()=>{
 for(const [platform,arch] of [['win32','x64'],['darwin','x64'],['darwin','arm64'],['linux','x64'],['linux','arm64']]) {
  let checked=0;await checkEnvironment({...linux,platform,arch,hasLibrary:async()=>{checked++;return true;}});
  assert.equal(checked,platform==='linux'?1:0);
 }
 await assert.rejects(checkEnvironment({...linux,arch:'arm'}),/暂不支持/);
});
test('Alpine 和过旧 glibc 在下载前提示更换镜像',async()=>{
 for(const glibc of ['', '2.28'])await assert.rejects(checkEnvironment({...linux,glibc,download:true,hasCommand:()=>assert.fail('must not download')}),EnvironmentError);
 await checkEnvironment({...linux,glibc:'2.30'});
});
test('基础库不依赖扩展系统库；扩展缺 EGL 提示确切安装命令',async()=>{
 const input={...linux,hasLibrary:async name=>name!=='libEGL.so.1'};
 await checkEnvironment(input);
 await assert.rejects(checkEnvironment({...input,extension:true}),e=>e instanceof EnvironmentError && /apt-get update && apt-get install -y libegl1/.test(e.detail));
 // Ubuntu derivatives and non-Debian systems do not receive a wrong package command.
 await assert.rejects(checkEnvironment({...input,extension:true,osRelease:'ID_LIKE="ubuntu debian"'}),e=>/apt-get/.test(e.detail));
 await assert.rejects(checkEnvironment({...input,extension:true,osRelease:'ID=fedora'}),e=>/libEGL.so.1/.test(e.detail)&&!/apt-get/.test(e.detail));
});
test('缓存运行不要求 curl/tar；新安装只提示缺少的工具',async()=>{
 await checkEnvironment({...linux,hasCommand:()=>assert.fail('cached run must not probe tools')});
 await assert.rejects(checkEnvironment({...linux,download:true,hasCommand:async name=>name!=='tar'}),e=>e.detail==='缺少工具：tar');
 const commands=[];
 await checkEnvironment({platform:'win32',arch:'x64',download:true,hasCommand:async name=>{commands.push(name);return true;}});
 assert.deepEqual(commands,['curl.exe','tar']);
});
test('环境检查失败在准备前展示，补齐后可重试；聊天仍不泄露环境诊断',async()=>{
 let healthy=false,loaded=0,prepared=0;
 const issue=new EnvironmentError('缺少必要组件，请按安装说明补齐后重试。','libegl1');
 const b=new BootstrapManager({dir:tmpdir(),runtimeDir:tmpdir(),log:{warn(){}},check:async()=>{if(!healthy)throw issue;},onReady:async()=>loaded++});
 // Exercise the real preflight before the child would be started.
 b.start();await b.task;assert.equal(b.status().error,issue.message);assert.ok(b.status().help.startsWith('https://github.com/'));assert.doesNotMatch(b.status().error,/libegl/);assert.equal(b.child,null);assert.equal(loaded,0);
 healthy=true;b.prepare=async()=>prepared++;b.start();await b.task;assert.equal(prepared,1);assert.equal(loaded,1);b.dispose();
 assert.doesNotMatch(publicErrorMessage(issue),/libegl/);
 assert.equal(environmentMessage(Error('/private/token=secret'),'fallback'),'fallback');
});
test('扩展检查失败不挂载、不改设置；卸载无需通过安装检查；启动恢复也检查',async()=>{
 let mounts=0,saves=0,healthy=false;
 const issue=new EnvironmentError('缺少必要组件，请按安装说明补齐后重试。','libegl1');
 const manager=new ExtensionManager({dir:tmpdir(),check:async()=>{if(!healthy)throw issue;},engine:{call:async(op,args)=>{mounts++;return{extensionEnabled:args.enabled,extensionCount:0};}},onCatalog(){},save:async()=>saves++,log:{warn(){}}});
 manager.start(true);await manager.task;
 assert.equal(manager.status().error,issue.message);assert.equal(manager.child,null);assert.equal(mounts,0);assert.equal(saves,0);
 await manager.restore();assert.equal(manager.status().error,issue.message);assert.equal(mounts,0);
 manager.start(false);await manager.task;assert.equal(mounts,1);assert.equal(saves,1);assert.equal(manager.status().error,'');
 healthy=true;await manager.restore();assert.equal(mounts,2);manager.dispose();
});
