import test from 'node:test';
import assert from 'node:assert/strict';
import { suggestWakeNames } from '../lib/speaker/wake-ai.mjs';
import { createFamilyCompanion } from '../lib/companion/runtime.mjs';
const words = ['小半','小办','小瓣','小拌','小绊','小扮','小版','晓伴','晓半','晓办'];
test('AI returns editable candidates using only the supplied wake words', async () => {
 let request; const input={primary:'小伴',existing:['晓伴']};
 const r=await suggestWakeNames(async o=>{request=o;return JSON.stringify(words)},input);
 assert.equal(r.ok,true);assert.equal(r.names.length,10);assert.deepEqual(input.existing,['晓伴']);
 assert.deepEqual(JSON.parse(request.text),input);
});
test('bad input never calls model; short duplicate or failed output preserves draft', async () => {
 assert.equal((await suggestWakeNames(()=>{throw Error('must not call')},{primary:''})).ok,false);
 for(const output of ['[]','not json',JSON.stringify(Array(12).fill('小半'))]) {
  assert.equal((await suggestWakeNames(async()=>output,{primary:'小伴'})).ok,false);
 }
 assert.equal((await suggestWakeNames(async()=>{throw Error('private')},{primary:'小伴'})).message.includes('private'),false);
});
test('speaker dialogue follows current host persona without independent storage or editor', async () => {
 let persona='Synthetic host A';const sessions=[];
 const api={core:{personas:{current:()=>persona}},ask:async o=>o.system,config:()=>({})};
 const service=await createFamilyCompanion(api,{},{
 makeSpeech:()=>({}),
 makeSession:async (a,r,o)=>{sessions.push(o.persona);return {ensure:async()=>{},close:async()=>{},cancel(){},status:()=>({})}}
 });
 assert.equal(service.savePersona,undefined);assert.equal(service.getPersona,undefined);
 await service.ensureSession();persona='Synthetic host B';await service.ensureSession();
 assert.deepEqual(sessions,['Synthetic host A','Synthetic host B']);await service.close();
});
