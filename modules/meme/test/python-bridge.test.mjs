import test from 'node:test';import assert from 'node:assert/strict';import{EventEmitter}from'node:events';import{PassThrough}from'node:stream';import{tmpdir}from'node:os';
import{PythonBridge}from'../lib/python-bridge.mjs';import{UserError,publicErrorMessage,userErrorForCode}from'../lib/errors.mjs';
test('扩展已知错误使用统一提示，未知内容不外泄；管道失败后可重启，停止后不可重启',async()=>{
 const bridge=new PythonBridge(tmpdir());bridge.runtime={executable:'fixture'};const children=[];
 bridge.spawnWorker=()=>{const c=new EventEmitter();c.stdout=new PassThrough();c.stderr=new PassThrough();c.stdin=new PassThrough();c.kill=()=>{c.exitCode=0;c.emit('exit',0);};c.exitCode=null;children.push(c);return c;};
 try{
 const first=bridge.call({op:'generate'}),bad=assert.rejects(first,e=>e instanceof UserError && e.message.includes('文字太长')&&!e.message.includes('secret'));
 children[0].stdout.write(JSON.stringify({id:1,error:'C:/secret/words',errorCode:'TextOverLength'})+'\n');await bad;
 const second=bridge.call({op:'generate'}),unknown=assert.rejects(second,e=>!publicErrorMessage(e).includes('secret'));
 children[0].stdout.write(JSON.stringify({id:2,error:'C:/secret/path',errorCode:'__proto__'})+'\n');await unknown;
 const third=bridge.call({op:'generate'}),pipe=assert.rejects(third);children[0].stdin.emit('error',Error('broken pipe'));await pipe;
 const next=bridge.call({op:'generate'});assert.equal(children.length,2);children[1].stdout.write(JSON.stringify({id:4,base64:'aA=='})+'\n');assert.equal((await next).toString(),'h');
 await bridge.dispose();assert.throws(()=>bridge.call({op:'generate'}),/停止/);
 for(const code of ['ImageDecodeError','OpenImageFailed','ArgModelMismatch','OutputTooLarge'])assert.ok(userErrorForCode(code) instanceof UserError);
 }finally{await bridge.dispose();}
});
