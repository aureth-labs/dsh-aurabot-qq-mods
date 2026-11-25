// 每日新闻一图流（news）测试：RSS/Atom 解析、HTML 清洗、URL 校验、内网拦截、简报校验。
// 全部走纯函数，不打真网络、不写模块数据目录。

import { test } from 'node:test'
import assert from 'node:assert/strict'

const { plain, httpURL, parseFeed, validateBrief, assertPublicTarget, FEED_PRESETS } = await import('../lib/news.mjs')

const RSS_SAMPLE = `<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0"><channel>
  <title>某科技周刊</title>
  <item>
    <title><![CDATA[DeepSeek 发布新版本，开源模型再进一步]]></title>
    <link>https://example.com/news/1</link>
    <pubDate>Wed, 05 Nov 2026 08:00:00 GMT</pubDate>
    <description><![CDATA[<p>这次更新在推理上有明显提升 &amp; 更多细节。</p><script>alert(1)</script>]]></description>
  </item>
  <item>
    <title>旧闻不该收录</title>
    <link>https://example.com/news/old</link>
    <pubDate>Wed, 05 Oct 2026 08:00:00 GMT</pubDate>
    <description>很久以前</description>
  </item>
  <item>
    <title>没有链接的条目</title>
    <pubDate>Wed, 05 Nov 2026 09:00:00 GMT</pubDate>
  </item>
</channel></rss>`

const ATOM_SAMPLE = `<?xml version="1.0" encoding="utf-8"?>
<feed xmlns="http://www.w3.org/2005/Atom">
  <entry>
    <title>原子格式也能读</title>
    <link rel="alternate" type="text/html" href="https://example.com/a/2"/>
    <updated>2026-11-05T09:30:00Z</updated>
    <summary>Atom 的 summary 字段</summary>
  </entry>
</feed>`

const NOW = Date.parse('2026-11-05T12:00:00Z')

test('plain 去掉 CDATA、标签、脚本和实体', () => {
  const out = plain('<![CDATA[<p>你好 &amp; 世界</p><script>alert(1)</script>]]>')
  assert.equal(out, '你好 & 世界')
})

test('plain 解码数字实体并保留正常文字', () => {
  assert.equal(plain('&#20320;&#x597d;'), '你好')
})

test('httpURL 接受 HTTP(S) 并去掉锚点', () => {
  assert.equal(httpURL('https://example.com/a#x'), 'https://example.com/a')
  assert.equal(httpURL('http://example.com/'), 'http://example.com/')
})

test('httpURL 拒绝非 HTTP 协议和带账号密码的地址', () => {
  assert.throws(() => httpURL('ftp://example.com/rss'), /HTTP\(S\)/)
  assert.throws(() => httpURL('https://user:pass@example.com/rss'), /HTTP\(S\)/)
})

test('parseFeed 解析 RSS：只留 48 小时内、有标题和链接的条目', () => {
  const items = parseFeed(RSS_SAMPLE, 'https://example.com/rss', NOW)
  assert.equal(items.length, 1)
  assert.equal(items[0].title, 'DeepSeek 发布新版本，开源模型再进一步')
  assert.equal(items[0].link, 'https://example.com/news/1')
  assert.match(items[0].excerpt, /这次更新.*更多细节/)
  assert.doesNotMatch(items[0].excerpt, /alert/)
})

test('parseFeed 解析 Atom：从 link href 取地址', () => {
  const items = parseFeed(ATOM_SAMPLE, 'https://example.com/feed', NOW)
  assert.equal(items.length, 1)
  assert.equal(items[0].link, 'https://example.com/a/2')
  assert.equal(items[0].excerpt, 'Atom 的 summary 字段')
})

test('parseFeed 识别预设源并带出来源名', () => {
  const preset = FEED_PRESETS[0]
  const items = parseFeed(RSS_SAMPLE, preset.url, NOW)
  assert.equal(items[0].source, preset.name)
  assert.equal(items[0].topic, preset.topic)
})

test('parseFeed 遇到坏 XML 返回空数组而不是抛错', () => {
  assert.deepEqual(parseFeed('<rss><channel><item><title>坏</title>', 'https://example.com/rss', NOW), [])
  assert.deepEqual(parseFeed('', 'https://example.com/rss', NOW), [])
})

test('assertPublicTarget 拒绝本机与内网地址', async () => {
  for (const target of ['http://127.0.0.1/x', 'http://localhost/x', 'http://10.0.0.1/x', 'http://192.168.1.1/x', 'http://172.16.0.1/x', 'http://169.254.169.254/x']) {
    await assert.rejects(assertPublicTarget(new URL(target)), /本机|内网/, target)
  }
})

test('assertPublicTarget 放行公网地址（不实际请求）', async () => {
  await assert.doesNotReject(assertPublicTarget(new URL('https://example.com/rss')))
})

const CANDIDATES = [
  { id: 1, link: 'https://example.com/1', source: '中新网', published: NOW, body: '正文' },
  { id: 2, link: 'https://example.com/2', source: 'IT之家', published: NOW },
  { id: 3, link: 'https://example.com/3', source: 'Solidot', published: NOW },
  { id: 4, link: 'https://example.com/4', source: '少数派', published: NOW },
]

test('validateBrief 按 id 对上来源并截断标题字数', () => {
  const raw = JSON.stringify({ items: [
    { id: 1, headline: '国产大模型发布新版本', summary: '推理能力提升，开源权重同步放出' },
    { id: 2, headline: '手机厂商公布新机', summary: '主打影像和续航' },
    { id: 3, headline: '开源社区修正安全问题', summary: '补丁已发布' },
  ] })
  const items = validateBrief(raw, CANDIDATES, 6)
  assert.equal(items.length, 3)
  assert.equal(items[0].link, 'https://example.com/1')
  assert.equal(items[0].source, '中新网')
  assert.equal(items[0].evidence, '正文及RSS')
  assert.equal(items[1].evidence, 'RSS标题及摘要')
})

test('validateBrief 支持去掉 ```json 代码块外壳', () => {
  const raw = '```json\n' + JSON.stringify({ items: [
    { id: 1, headline: 'a', summary: 'b' }, { id: 2, headline: 'c', summary: 'd' }, { id: 3, headline: 'e', summary: 'f' },
  ] }) + '\n```'
  assert.equal(validateBrief(raw, CANDIDATES, 6).length, 3)
})

test('validateBrief 只在国内模式保留 domestic=true 的条目', () => {
  const raw = JSON.stringify({ items: [
    { id: 1, headline: '国内', summary: 'x', domestic: true },
    { id: 2, headline: '海外', summary: 'y', domestic: false },
    { id: 3, headline: '国内二', summary: 'z', domestic: true },
  ] })
  assert.throws(() => validateBrief(raw, CANDIDATES, 6, true), /不足3条/)
})

test('validateBrief 拒绝重复 id、未知 id 和空字段', () => {
  const raw = JSON.stringify({ items: [
    { id: 1, headline: '', summary: 'x' },
    { id: 1, headline: 'a', summary: 'b' },
    { id: 99, headline: 'c', summary: 'd' },
    { id: 2, headline: 'e', summary: 'f' },
    { id: 3, headline: 'g', summary: 'h' },
  ] })
  const items = validateBrief(raw, CANDIDATES, 6)
  assert.deepEqual(items.map(i => i.link), ['https://example.com/1', 'https://example.com/2', 'https://example.com/3'])
})

test('validateBrief 在有效条目不足 3 条时报错', () => {
  const raw = JSON.stringify({ items: [{ id: 1, headline: 'a', summary: 'b' }] })
  assert.throws(() => validateBrief(raw, CANDIDATES, 6), /不足3条/)
})

test('validateBrief 遇到无效 JSON 抛错', () => {
  assert.throws(() => validateBrief('not json', CANDIDATES, 6))
  assert.throws(() => validateBrief(JSON.stringify({ nope: [] }), CANDIDATES, 6), /有效新闻列表/)
})
