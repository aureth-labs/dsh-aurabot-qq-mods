import test from 'node:test';
import assert from 'node:assert/strict';
import { formatTemplateList } from '../lib/list.mjs';
const items = Array.from({ length: 45 }, (_, i) => ({ key: `hold_${i}`, keywords: [`角色${i + 1}举牌`], tags: ['举牌'] }));
items.push({ key: 'other', keywords: ['其它模板'], tags: [] });
test('搜索第一页提供保留关键词的下一页指令', () => {
  const text = formatTemplateList(items, '举牌');
  assert.match(text, /45 个 · 1\/3 页/);
  assert.match(text, /下一页：#表情搜索 举牌 2/);
  assert.doesNotMatch(text, /上一页|其它模板|hold_/);
});
test('搜索中间页和末页的内容与双向导航', () => {
  const middle = formatTemplateList(items, '举牌 2');
  assert.match(middle, /45 个 · 2\/3 页\n角色21举牌/);
  assert.match(middle, /角色40举牌\n上一页：#表情搜索 举牌 1\n下一页：#表情搜索 举牌 3/);
  assert.doesNotMatch(middle, /角色20举牌|角色41举牌/);
  const last = formatTemplateList(items, '举牌 3');
  assert.match(last, /3\/3 页\n角色41举牌/);
  assert.match(last, /角色45举牌\n上一页：#表情搜索 举牌 2/);
  assert.doesNotMatch(last, /下一页/);
});
test('普通列表页码保留，越界页码收敛，不输出无效导航', () => {
  assert.match(formatTemplateList(items, '2'), /46 个 · 2\/3 页/);
  assert.match(formatTemplateList(items, '2'), /下一页：#表情列表 3/);
  assert.match(formatTemplateList(items, '举牌 99'), /3\/3 页/);
  assert.match(formatTemplateList(items, '举牌 0'), /1\/3 页/);
  assert.doesNotMatch(formatTemplateList(items, '不存在 2'), /上一页|下一页/);
});
test('保留带空格的关键词，支持多余空白', () => {
  const many = Array.from({length: 25}, () => ({key:'x', keywords:['Hello World'], tags:[]}));
  assert.match(formatTemplateList(many, '  hello world   2 '), /25 个 · 2\/2 页/);
  assert.match(formatTemplateList(many, 'hello world 2'), /上一页：#表情搜索 hello world 1/);
});
