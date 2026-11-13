import test from 'node:test';
import assert from 'node:assert/strict';
import { indexEntries, buildIndexSvg } from '../lib/index-image.mjs';
const items = [
  { key: 'b', keywords: ['english', '中文触发词'], params: { maxImages: 2, maxTexts: 1 } },
  { key: 'a', keywords: ['only_text'], params: { maxImages: 0, maxTexts: 2 } },
  { key: 'c', keywords: ['图片'], params: { maxImages: 1, maxTexts: 0 } },
];
test('完整编号、中文优先、图片和文字标记独立，包含禁用模板', () => {
  assert.deepEqual(indexEntries(items, ['b']), [
    { number: 1, key: 'a', label: 'only_text', image: false, text: true, disabled: false },
    { number: 2, key: 'b', label: '中文触发词', image: true, text: true, disabled: true },
    { number: 3, key: 'c', label: '图片', image: true, text: false, disabled: false },
  ]);
});
test('730 个条目在单张图内，编号首尾齐全，名称不截断', () => {
  const all = Array.from({ length: 730 }, (_, n) => ({ ...items[n % 3], key: String(n).padStart(3, '0') }));
  const result = buildIndexSvg(all);
  assert.equal(result.entries.length, 730);
  assert.equal((result.svg.match(/data-key=/g) || []).length, 730);
  assert.match(result.svg, />001<\/text>/); assert.match(result.svg, />730<\/text>/);
  assert.equal(result.width, 2784); assert.ok(result.height <= 10000);
  assert.doesNotMatch(result.svg, /<image|https?:\/\/(?!www\.w3\.org)/);
  const long = '长名称必须完整显示不能省略或截断'.repeat(4);
  const svg = buildIndexSvg([{ ...items[0], keywords: [long] }]).svg;
  assert.ok(svg.includes('长名称必须完整显示不能省略'));
  assert.ok(buildIndexSvg([{ ...items[0], keywords: ['A&B<test>'] }]).svg.includes('A&amp;B&lt;test&gt;'));
});

test('目录列数可选 4/5/6/7，默认 5 列；条目始终完整', () => {
  const all=Array.from({length:1006},(_,n)=>({...items[0],key:String(n)}));
  for(const n of [4,5,6,7]) {
    const result=buildIndexSvg(all,[],n);
    assert.equal(result.width,96+512*n+32*(n-1));
    assert.equal(result.entries.length,1006);
    assert.equal((result.svg.match(/data-key=/g)||[]).length,1006);
  }
  assert.equal(buildIndexSvg(items,[],0).width,buildIndexSvg(items,[],5).width);
});
