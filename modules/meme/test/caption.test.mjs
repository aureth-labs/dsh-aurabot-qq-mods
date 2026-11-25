import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { createCaptionTemplates, fitCaption, captionSvg } from '../lib/caption-templates.mjs';
import { buildIndex, matchTemplate, parseInput } from '../lib/catalog.mjs';
const root = fileURLToPath(new URL('..', import.meta.url));
const defs = JSON.parse(readFileSync(new URL('../assets/templates.json',import.meta.url),'utf8'));
test('自带模板文字区在画布内，短文/长文换行适配，超长提示不截断',()=>{
  for(const t of defs){
    const b=t.textBox;assert.ok(b.x>=0&&b.y>=0&&b.x+b.width<=t.width&&b.y+b.height<=t.height);
    for(const text of [t.defaultText,'今天的显存也要留给重要的事情。'.repeat(4)]){
      const result=fitCaption(text,b);assert.equal(result.lines.join('').replace(/\s/g,''),text.replace(/\s/g,''));
      assert.ok(result.lines.length*result.lineHeight<=b.height);
    }
    assert.throws(()=>fitCaption('显存'.repeat(500),b),/文字太长/);
  }
});
test('中文标点优先换行，不把短语切成孤字',()=>{
 assert.deepEqual(fitCaption('买得越多，省得越多。',defs[1].textBox).lines,['买得越多，','省得越多。']);
});
test('SVG 转义用户文字，不能注入图片或外链',()=>{
 const svg=captionSvg(defs[0],'<script>&"test"','AAAA');
 assert.doesNotMatch(svg,/<script>/);assert.match(svg,/&lt;/);assert.match(svg,/&amp;/);
 assert.equal((svg.match(/<image /g)||[]).length,1);
});
test('两个基础模板、别名、默认文字和笑哭切换共享同一路径',async()=>{
 const rendered=[];const local=createCaptionTemplates(root,async svg=>{rendered.push(svg);return {buffer:Buffer.from('ok')};});
 assert.equal(local.items.length,2);const index=buildIndex(local.items);
 for(const phrase of ['黄仁勋说','老黄说','黄仁勋举牌','老黄举牌']){
   const m=matchTemplate(phrase,index);assert.ok(m);const input=parseInput(m.rest,m.item,m.shortcut);
   assert.equal(input.texts.length,1);await local.render(m.item.key,input.texts,input.options);
 }
 const smile=rendered.at(-1);
 const crying=matchTemplate('老黄哭举牌 显存不够了',index);assert.ok(crying);
 const input=parseInput(crying.rest,crying.item,crying.shortcut);assert.equal(input.options['表情'].field0,'哭');
 await local.render(crying.item.key,input.texts,input.options);assert.notEqual(rendered.at(-1),smile);
 const manual=parseInput('显存不够了 --表情 哭',crying.item);assert.deepEqual(manual.options,input.options);
 await assert.rejects(local.render(crying.item.key,['你好'],{'表情':{field0:'invalid'}}),/表情可选：笑、哭/);
});
