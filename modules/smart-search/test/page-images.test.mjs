import test from 'node:test';
import assert from 'node:assert/strict';
import { pageResult } from '../lib/results.mjs';
import { createSearch } from '../lib/search.mjs';
import { harness } from './helpers.mjs';
const page = html => ({url:'https://example.com/characters/index.html',html:true,content:html});
test('default output stays text-only; image extraction preserves the same text',()=>{
 const raw=page('<h1>角色</h1><p>宝宝</p><img src="../img/a.png?x=1&amp;y=2" alt="宝宝 &amp; 皮蛋">');
 const old=pageResult(raw,'dsh'), next=pageResult(raw,'dsh',{includeImages:true});
 assert.equal(old.text,next.text);assert.equal('images' in old,false);
 assert.deepEqual(next.images,[{url:'https://example.com/img/a.png?x=1&y=2',description:'宝宝 & 皮蛋'}]);
});
test('handles lazy images, malformed HTML, duplicates and extensionless URLs without fetching them',()=>{
 const result=pageResult(page('<img src="data:image/png;base64,abc" data-src="//cdn.example.com/image?id=4" alt="宝宝"><img src="//cdn.example.com/image?id=4"><img data-original="/original" src="/placeholder"><IMG SRC="/second" title="第二张">'),'dsh',{includeImages:true});
 assert.deepEqual(result.images.map(x=>x.url),['https://cdn.example.com/image?id=4','https://example.com/original','https://example.com/second']);
 assert.equal(result.images[2].description,'第二张');
});
test('does not execute script markup or return local, credentialed or non-http image addresses',()=>{
 const bad=['http://127.0.0.1/a','http://10.1.2.3/a','http://[::1]/a','http://169.254.169.254/a','https://user:password@example.com/a','file:///secret','data:image/png;base64,AAAA','javascript:alert(1)'];
 const result=pageResult(page('<p>页面</p><script>"<img src=\'/script.png\'>"</script>'+bad.map(src=>`<img src="${src}">`).join('')),'dsh',{includeImages:true});
 assert.deepEqual(result.images,[]);
});
test('image-only pages work on request; a bounded candidate list reports omission',()=>{
 const raw=page(Array.from({length:25},(_,i)=>`<img src="/${i}.png" alt="${'x'.repeat(300)}">`).join(''));
 assert.throws(()=>pageResult(raw,'dsh'),{code:'page'});
 const result=pageResult(raw,'dsh',{includeImages:true});assert.equal(result.images.length,20);assert.equal(result.imagesTruncated,true);assert.equal(result.images[0].description.length,200);
});
test('text-only extraction services do not falsely claim the page has no images',()=>{
 const result=pageResult({url:'https://example.com/',content:'文字资料'},'exa',{includeImages:true});
 assert.deepEqual(result.images,[]);assert.match(result.imageNote,/空列表不代表网页没有图片/);
});
test('tool execution passes the option through, charges one read and rejects invalid flags',async()=>{
 let count=0;const h=harness();const service=createSearch(h.api,{pageReader:async()=>{count++;return page('<p>正文</p><img src="/cat">')}});
 try {
  assert.equal((await service.run('read',{url:'https://example.com',includeImages:true})).images.length,1);
  assert.equal('images' in await service.run('read',{url:'https://example.com'}),false);
  assert.equal((await service.run('read',{url:'https://example.com',includeImages:'true'})).code,'request');
  assert.equal(count,2);
 }finally{service.dispose()}
});
