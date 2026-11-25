import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { pathToFileURL } from 'node:url';
import { spawnSync } from 'node:child_process';
import { buildExtension } from '../lib/build.mjs';

test('distribution imports from a fresh directory without node_modules or browser installation',async()=>{
  const dir=mkdtempSync(join(tmpdir(),'tieba-distribution-'));
  try {
    await buildExtension(dir);
    const pkg=JSON.parse(readFileSync(join(dir,'package.json'),'utf8'));
    assert.equal(pkg.dependencies,undefined);
    assert.equal(pkg.scripts,undefined);
    const result=spawnSync(process.execPath,['--input-type=module','-e',`const m=await import(${JSON.stringify(pathToFileURL(join(dir,'index.mjs')).href)}); console.log(m.default.version);`],{cwd:dir,encoding:'utf8',windowsHide:true});
    assert.equal(result.status,0,result.stderr);
    assert.equal(result.stdout.trim(),pkg.version);
    assert.ok(readFileSync(join(dir,'lib','session.cjs'),'utf8').includes('configureCookies'));
    assert.ok(existsSync(join(dir,'lib','browser.cjs')));
    assert.ok(existsSync(join(dir,'lib','login.cjs')));
    const forum=readFileSync(new URL('fixtures/forum-modern.html',import.meta.url),'utf8');
    const post=readFileSync(new URL('fixtures/post-modern.html',import.meta.url),'utf8');
    const script=`
      import def from ${JSON.stringify(pathToFileURL(join(dir,'index.mjs')).href)};
      const data=${JSON.stringify(join(dir,'data'))};
      const html={browse:${JSON.stringify(forum)},read:${JSON.stringify(post)}};
      const api={dir:${JSON.stringify(dir)},dataDir:f=>data+'/'+f,lib:()=>({registerSecretField(){}}),settings:()=>def.defaults,config:()=>({}),onDispose(){},tool(){},rule(){},every(){},route(){},dsh:{},core:{}};
      const reader=def.setup(api,{renderPage:async(_url,kind)=>({html:html[kind]})});
      const list=await reader.browse('测试');const page=await reader.read(list.items[0].url);
      if(list.items[0].title!=='现代列表标题'||!page.ok||!page.posts[0].text.includes('楼主正文'))process.exit(2);
    `;
    const parsed=spawnSync(process.execPath,['--input-type=module','-e',script],{cwd:dir,encoding:'utf8',windowsHide:true});
    assert.equal(parsed.status,0,parsed.stderr);
    const notices=readFileSync(join(dir,'THIRD-PARTY-NOTICES.md'),'utf8');
    assert.match(notices,/cheerio@1\.2\.0/);assert.match(notices,/Copyright/);
  } finally {rmSync(dir,{recursive:true,force:true});}
});
