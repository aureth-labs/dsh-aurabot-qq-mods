import test from 'node:test';
import assert from 'node:assert/strict';
import {parseInput,buildIndex,matchTemplate} from '../lib/catalog.mjs';
import {rawText,collectImages} from '../lib/media.mjs';
const item={key:'fixture',keywords:['测试'],shortcuts:[],params:{minImages:0,maxImages:0,minTexts:1,maxTexts:1,defaultTexts:['默认'],options:[{type:'String',field0:{name:'name'}},{type:'Integer',field0:{name:'size',minimum:1,maximum:10}},{type:'Boolean',field0:{name:'circle'}}]}};
test('单段文案保留斜杠、换行和空格，带空格的参数值完整解析',()=>{
 assert.deepEqual(parseInput('https://a.test/b\n今天  开心',item).texts,['https://a.test/b\n今天  开心']);
 const r=parseInput('正文 --name="甲 乙" --size 2 --circle false',item);
 assert.deepEqual(r.texts,['正文']);assert.equal(r.options.name.field0,'甲 乙');assert.equal(r.options.size.field0,2);assert.equal(r.options.circle.field0,false);
 assert.deepEqual(parseInput('-- #话题 --这也是正文',item).texts,['#话题 --这也是正文']);
 assert.deepEqual(parseInput("don't stop",item).texts,["don't stop"]);
 assert.throws(()=>parseInput('--size 99',item),/范围/);
});
test('多段文案尊重引号内的斜杠，空段按默认文字补齐',()=>{
 const multi={...item,params:{...item.params,minTexts:2,maxTexts:3,defaultTexts:['甲','乙']}};
 assert.deepEqual(parseInput('"a/b" / c',multi).texts,['a/b','c']);
 assert.deepEqual(parseInput('/ 第二段',multi).texts,['甲','第二段']);
 assert.deepEqual(parseInput('第一段 /',multi).texts,['第一段','乙']);
 assert.throws(()=>parseInput('1/2/3/4',multi),/段文字/);
});
test('零文字模板不把库里的预览文案当成输入；显式多余文案仍提示错误',()=>{
 const zero={...item,params:{...item.params,minTexts:0,maxTexts:0}};
 assert.deepEqual(parseInput('',zero).texts,[]);assert.throws(()=>parseInput('多余文字',zero),/段文字/);
});
test('快捷触发词里的名字和文案统一替换',()=>{
 const index=buildIndex([{...item,shortcuts:[{pattern:'测试(?P<name>\\S+)',names:['{name}'],texts:['{name}'],options:{}}]}]);
 const r=matchTemplate('测试甲',index);assert.deepEqual(r.shortcut.names,['甲']);assert.deepEqual(parseInput('',item,r.shortcut).texts,['甲']);
});
test('CQ 字符串里的真实 @、图片、引用按消息段处理，转义文字不当作指令',async()=>{
 const fetched=[];const api={lib:()=>({fetchImage:async url=>{fetched.push(url);return Buffer.from(url);}}),onebot:async()=>({message:'[CQ:image,url=https://example.test/quote.png]'})};
 const msg={userId:'111111',nickname:'甲',raw:{self_id:'333333',message:'#测试 [CQ:at,qq=222222,name=乙]'}};
 assert.equal(rawText(msg),'#测试');
 await collectImages(api,msg,{minImages:1,maxImages:1},new Map());assert.match(fetched.pop(),/nk=222222/);
 msg.raw.message='#测试 [CQ:reply,id=42][CQ:at,qq=222222]';
 await collectImages(api,msg,{minImages:1,maxImages:1},new Map());assert.equal(fetched.pop(),'https://example.test/quote.png');
 assert.equal(rawText({raw:{message:'&#91;CQ:at,qq=222222&#93; &amp;'}}),'[CQ:at,qq=222222] &');
});
test('附图已满足数量时，不依赖旧引用消息能否读取',async()=>{
 const api={lib:()=>({fetchImage:async()=>Buffer.from('picture')}),onebot:async()=>{throw Error('引用已撤回');}};
 const images=await collectImages(api,{replyId:'42',images:[{data:{url:'https://example.test/image.png'}}]},{minImages:1,maxImages:1},new Map());
 assert.equal(images.length,1);
});
test('图片和表情包混发时保持消息中的先后顺序',async()=>{
 const sticker={type:'mface',data:{url:'https://example.test/first.gif'}},picture={type:'image',data:{url:'https://example.test/second.png'}};
 const api={lib:()=>({fetchImage:async url=>Buffer.from(url)})};
 const result=await collectImages(api,{raw:{message:[sticker,picture]},images:[picture],stickers:[sticker]},{minImages:2,maxImages:2},new Map());
 assert.deepEqual(result.map(x=>Buffer.from(x.data,'base64').toString()),[sticker.data.url,picture.data.url]);
});
