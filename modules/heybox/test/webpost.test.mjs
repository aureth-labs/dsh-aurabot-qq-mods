// 网页兜底发帖：纯逻辑部分的回归（不真起浏览器）
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { shouldFallbackToWeb, blocksToEditorHtml, parseCookie, WEB_FALLBACK_HINTS } from '../lib/webpost.mjs'

test('只有「接口被关掉」这类软拒才走网页兜底', () => {
  for (const h of WEB_FALLBACK_HINTS) {
    assert.equal(shouldFallbackToWeb({ ok: false, message: `小黑盒拒绝（failed）：${h}` }), true, h + ' 该兜底')
  }
  // 发成功不兜底
  assert.equal(shouldFallbackToWeb({ ok: true }), false)
  // 字数问题走浏览器也一样被拒，兜它纯浪费
  assert.equal(shouldFallbackToWeb({ ok: false, code: 'too_short', message: '太短' }), false)
  assert.equal(shouldFallbackToWeb({ ok: false, code: 'too_long', message: '太长' }), false)
  assert.equal(shouldFallbackToWeb({ ok: false, code: 'bad_topic', message: '发布功能暂不可用' }), false, '分区错要先修分区')
  // 网络 / 登录态问题不兜底（浏览器也是同一份网、同一份 Cookie）
  assert.equal(shouldFallbackToWeb({ ok: false, message: 'HTTP 500：服务端错误' }), false)
  assert.equal(shouldFallbackToWeb({ ok: false, message: '登录态失效（failed）' }), false)
  assert.equal(shouldFallbackToWeb(null), false)
})

test('blocks 转编辑器 HTML：文字与图片按原顺序，图片节点带 data-type=image', () => {
  const html = blocksToEditorHtml([
    { type: 'html', text: '<p>第一段</p><p>第二段</p>' },
    { type: 'img', url: 'https://img.xiaoheihe.cn/a.png', width: '1080', height: '780' },
  ])
  assert.match(html, /<p>第一段<\/p>/)
  assert.match(html, /data-type="image"/, 'ProseMirror 认这个属性')
  assert.match(html, /data-original="https:\/\/img\.xiaoheihe\.cn\/a\.png"/)
  assert.match(html, /data-width="1080"/)
  assert.ok(html.indexOf('第一段') < html.indexOf('<img'), '图片必须在文字之后（保持原顺序）')
  // 缺宽高时给默认值，别输出 data-width="undefined"
  const h2 = blocksToEditorHtml([{ type: 'img', url: 'https://x/b.png' }])
  assert.doesNotMatch(h2, /undefined/)
  assert.match(h2, /data-width="1080"/)
  // 空输入不炸
  assert.equal(blocksToEditorHtml(null), '')
  assert.equal(blocksToEditorHtml([]), '')
})

test('Cookie 文本解析成 CDP 要的 name/value', () => {
  const c = parseCookie('pkey=abc%3D%3D; heybox_id=123; x_xhh_tokenid=xyz')
  assert.deepEqual(c, [
    { name: 'pkey', value: 'abc%3D%3D' },
    { name: 'heybox_id', value: '123' },
    { name: 'x_xhh_tokenid', value: 'xyz' },
  ])
  // 值里带等号要保留（base64 常见）
  assert.deepEqual(parseCookie('a=b=c'), [{ name: 'a', value: 'b=c' }])
  // 脏输入丢掉，不要造出空 name
  assert.deepEqual(parseCookie('; ;  =x; ok=1'), [{ name: 'ok', value: '1' }])
  assert.deepEqual(parseCookie(''), [])
  assert.deepEqual(parseCookie(null), [])
})
