import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import definition from '../index.mjs';
test('market metadata matches entry and portable defaults', async () => {
 const m=JSON.parse(await readFile(new URL('../module.json',import.meta.url),'utf8'));
 for(const key of ['id','version','api']) assert.equal(m[key],definition[key]);
 assert.equal(definition.tab,undefined); assert.equal(definition.id,'xiaoai-music'); assert.equal(definition.defaults.resourceRoot,''); assert.equal(definition.defaults.networkInterface,'');
});
test('fresh setup uses host module data directory and remains inactive', async () => {
 const root=await mkdtemp(join(tmpdir(),'family-market-'));const routes=new Map(), disposers=[];
 try { await definition.setup({settings:()=>({}),dataDir:()=>root,route:(p,h)=>routes.set(p,h),every(){},on(){},tool(){},rule(){},defineTool:v=>v,onDispose:f=>disposers.push(f),core:{http:{}}});
 const status=await routes.get('/status')();assert.equal(status.listener.enabled,false);assert.equal(status.connected,false);
 assert.equal(status.storage.root,''); assert.equal(status.onboarding.storageReady,false);
 assert.equal(status.onboarding.complete,false);
 } finally {for(const f of disposers) await f();await rm(root,{recursive:true,force:true});}
});
test('review build excludes runtime program installer', async () => {
 const s=await readFile(new URL('../lib/songs/studio.mjs',import.meta.url),'utf8');
 assert.doesNotMatch(s,/runInstall|ensureUv|Invoke-WebRequest|pip', 'install/);
});
