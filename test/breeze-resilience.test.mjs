import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createSynthQueue, retryAfterMs, fetchBreeze } from '../modules/breeze/lib/resilience.mjs'
const response=(status, retry)=>({ok:status===200,status,headers:new Headers(retry?{'retry-after':retry}:{}),text:async()=> 'GENERATION_CONCURRENCY_EXCEEDED'})
test('Retry-After 接受秒数和 HTTP 日期',()=>{
 assert.equal(retryAfterMs('3'),3000);assert.equal(retryAfterMs('Mon, 16 Nov 2026 05:00:02 GMT',Date.parse('2026-11-16T05:00:00Z')),2000);assert.equal(retryAfterMs('no'),null)
})
test('429 按头等待后恢复；无头有限退避，不无限重试',async()=>{
 let n=0;const waits=[]; const r=await fetchBreeze('fixture',{}, {fetchImpl:async()=>response(++n===3?200:429,n===1?'1':null),wait:async ms=>waits.push(ms)});
 assert.equal(r.status,200);assert.deepEqual(waits,[1000,4000]);assert.equal(n,3)
 n=0;await assert.rejects(()=>fetchBreeze('fixture',{}, {fetchImpl:async()=>{n++;return response(429)},wait:async()=>{}}),/429/);assert.equal(n,3)
})
test('长 Retry-After 不截短，500/超时不重发',async()=>{
 let n=0;for(const status of [429,500]){n=0;await assert.rejects(()=>fetchBreeze('fixture',{}, {fetchImpl:async()=>{n++;return response(status,'120')},wait:async()=>{throw Error('不应等待')}}));assert.equal(n,1)}
 n=0;await assert.rejects(()=>fetchBreeze('fixture',{}, {fetchImpl:async()=>{n++;throw Error('timeout')}}),/timeout/);assert.equal(n,1)
})
test('跨请求串行；失败不堵队列',async()=>{
 const run=createSynthQueue();let active=0,max=0;const work=async()=>{max=Math.max(max,++active);await new Promise(r=>setTimeout(r,5));active--;return 'ok'};
 assert.deepEqual(await Promise.all([run(work),run(work),run(work)]),['ok','ok','ok']);assert.equal(max,1)
 await assert.rejects(run(async()=>{throw Error('失败')}));assert.equal(await run(work),'ok')
})
test('排队超时/取消不会迟到调用上游',async()=>{
 const run=createSynthQueue({waitMs:10});let release;let called=false;
 const active=run(()=>new Promise(r=>{release=r}));await new Promise(setImmediate);
 const pending=run(()=>{called=true});await Promise.all([assert.rejects(pending),new Promise(r=>setTimeout(r,20))]);
 release();await active;await new Promise(setImmediate);assert.equal(called,false)
 const cancel=new AbortController();cancel.abort();await assert.rejects(run(()=>{called=true},cancel.signal));assert.equal(called,false)
})
