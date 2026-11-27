import test from 'node:test'
import assert from 'node:assert/strict'
import { resolveQr, clipQrText, qrCapacityForDots, qrModuleSize, qrVersionForBytes } from '../lib/qr.mjs'
import { momentUrl } from '../lib/moments.mjs'

test('二维码：auto 有链接就用链接', () => {
  assert.equal(resolveQr({ mode: 'auto', custom: '{date}', url: 'https://example.com/a' }), 'https://example.com/a')
  assert.equal(resolveQr({ mode: 'auto', custom: '店里 WiFi', url: '  ' }), '店里 WiFi')
})

test('二维码：custom 只认自定义文字，off 直接不打', () => {
  assert.equal(resolveQr({ mode: 'custom', custom: 'AURABOT', url: 'https://example.com' }), 'AURABOT')
  assert.equal(resolveQr({ mode: 'off', custom: 'AURABOT', url: 'https://example.com' }), '')
  assert.equal(resolveQr({ mode: 'off' }), '')
})

test('说说网址：宿主给了 url 就用它', () => {
  assert.equal(momentUrl({ url: 'https://qzone.qq.com/x' }), 'https://qzone.qq.com/x')
  assert.equal(momentUrl({ tid: 'https://qzone.qq.com/y' }), 'https://qzone.qq.com/y')
})

test('说说网址：uin + tid 拼 QQ 空间地址', () => {
  assert.equal(momentUrl({ tid: 'ABC123', uin: '10001' }), 'https://user.qzone.qq.com/10001/mood/ABC123')
  assert.equal(momentUrl({ id: 'XYZ', userId: '123456' }), 'https://user.qzone.qq.com/123456/mood/XYZ')
})

test('说说网址：拼不出来就返回空，交给固定二维码', () => {
  assert.equal(momentUrl({}), '')
  assert.equal(momentUrl({ tid: 'ABC' }), '')
  assert.equal(momentUrl({ tid: 'ABC', uin: 'abc' }), '')
})

test('二维码尺寸：短内容仍用 6，长内容自动缩小不出纸边', () => {
  assert.equal(qrModuleSize({ bytes: 20, dots: 384 }), 6)
  const long = qrModuleSize({ bytes: 1200, dots: 384 })
  assert.ok(long >= 2 && long < 6, `长内容应该缩小：${long}`)
  assert.ok(qrVersionForBytes(20) <= 2)
  assert.ok(qrVersionForBytes(1200) > 20)
})

test('二维码容量：纸越窄能塞的字越少，但至少能放一个短链接', () => {
  const wide = qrCapacityForDots(576, 2)
  const narrow = qrCapacityForDots(240, 2)
  assert.ok(wide > narrow)
  assert.ok(narrow >= 100)
})

test('二维码截断：不切坏中文，末尾加省略号，不超字节上限', () => {
  const text = '打印机：DL\n驱动：C:\\Windows\\System32\\spool\\drivers\\x64\\3\\dl58.dll\n端口：USB001'
  assert.equal(clipQrText(text, 4096), text)
  const clipped = clipQrText(text, 60)
  assert.ok(Buffer.byteLength(clipped, 'utf8') <= 60, `超长了：${Buffer.byteLength(clipped, 'utf8')}`)
  assert.ok(clipped.endsWith('…'))
  assert.ok(!clipped.includes('\uFFFD'), '不能切出乱码')
})
