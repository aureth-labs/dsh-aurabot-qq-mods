import { seedRuntimeMetadata } from './helpers/runtime.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, mkdir, writeFile, readFile, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import module from '../index.mjs';
import { Engine } from '../lib/engine.mjs';
import { UserError, publicErrorMessage } from '../lib/errors.mjs';
import { prepareSkiaData, assertSkiaData } from '../scripts/python-data.mjs';
const secret = 'SkIcuLoader C:\\Users\\PrivateName\\secret\\icudtl.dat\nTOKEN=private-token\n/root/private/file';
test('未知异常默认隐藏；只有显式用户错误可以显示', () => {
  for (const error of [new Error(secret), { name: 'UserError', message: secret }, Object.assign(new Error(secret), {code:'ENOENT'})]) {
    assert.equal(publicErrorMessage(error), '暂时无法处理，请稍后重试；若仍失败，请联系主人。');
  }
  assert.equal(publicErrorMessage(new UserError('请附图')), '请附图');
});
test('聊天制作、预览、管理、初始化和面板错误不外泄，诊断留在日志', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'meme-errors-'));
  await seedRuntimeMetadata(dir);
  const original = Engine.prototype.call;
  const item = {key:'test',keywords:['测试'],tags:[],shortcuts:[],params:{minImages:0,maxImages:0,minTexts:0,maxTexts:1,defaultTexts:[],options:[]}};
  let failLoad=false, handle;
  const replies=[], logs=[], routes=new Map();
  const settings={...module.defaults,cooldown:0,extensionEnabled:false};
  const api={dir, dataDir:name=>join(dir,name),settings:()=>settings,log:{info(){},warn:(...v)=>logs.push(v.join(' ')),error:(...v)=>logs.push(v.join(' '))},on(){},command(){},route:(p,fn)=>routes.set(p,fn),onDispose(){},isOwner:()=>true,saveSettings(){throw Error(secret)},reply:async(msg,text)=>replies.push(text),core:{http:{body:async()=>({key:'test'})}}};
  Engine.prototype.call=async function(op){if(op==='catalog'&&!failLoad)return{items:[item],version:'test'};throw Error(secret);};
  try {
    handle=await module.setup(api);
    for (const text of ['#测试','#表情预览 测试','#表情禁用 测试']) {
      await handle.handle({kind:'private',chatId:'p',userId:'1',text});
      assert.match(replies.at(-1), /暂时无法处理/);assert.doesNotMatch(replies.at(-1), /PrivateName|TOKEN|icudtl|\/root/);
    }
    await assert.rejects(routes.get('/preview')({method:'POST',socket:{remoteAddress:'127.0.0.1'}}), e=>!e.message.includes('PrivateName')&&/暂时无法处理/.test(e.message));
    await handle.handle({kind:'private',chatId:'p',userId:'1',text:'#测试 --bad value'});
    assert.match(replies.at(-1), /不支持参数 bad/);
    assert.ok(logs.some(x=>x.includes(secret)));
    handle.dispose();failLoad=true;handle=await module.setup(api);
    await handle.handle({kind:'private',chatId:'p',userId:'1',text:'#表情列表'});
    assert.equal(replies.at(-1),'模板库暂时不可用，请联系主人');
    assert.doesNotMatch(handle.status().error, /PrivateName|TOKEN|icudtl/);
  } finally {handle?.dispose();Engine.prototype.call=original;await rm(dir,{recursive:true,force:true});}
});
test('Windows ICU 数据从 wheel 安装位置复用，重复准备无副本，缺失时阻止打包', async () => {
  const home=await mkdtemp(join(tmpdir(),'meme-icu-'));
  try {
    await assert.rejects(assertSkiaData(home,'win32-x64'),/ICU/);
    const source=join(home,'site-packages','Lib','site-packages','icudtl.dat');
    await mkdir(join(home,'site-packages','Lib','site-packages'),{recursive:true});await writeFile(source,'fixture');
    await prepareSkiaData(home,'win32-x64');await prepareSkiaData(home,'win32-x64');
    await assertSkiaData(home,'win32-x64');
    assert.equal(await readFile(join(home,'site-packages','icudtl.dat'),'utf8'),'fixture');
    assert.ok((await stat(source)).nlink>=2);
  } finally {await rm(home,{recursive:true,force:true});}
});
