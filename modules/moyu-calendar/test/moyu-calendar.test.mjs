// 摸鱼人日历：解析、匹配、状态机和定时发送。全部用假网络和临时目录，不访问外网。
import { test, before } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
import { readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Readable } from 'node:stream'
import { ARTICLE_EXPR, decodeBasic, imagesFromHtml, pickCalendarImage, readArticle } from '../lib/article.mjs'
import { albumListUrl, articleMeta, articleUrl, calendarFromAlbum, findTodayArticle, parseAlbum } from '../lib/album.mjs'
import { detectMime, downloadImage, originalImageUrl, pruneCache, readCache, removeCache, writeCache } from '../lib/image.mjs'
import { assertPublicHttp, calendarFromRss, feedOrigin, findToday, imageFromEntry, parseFeed } from '../lib/rss.mjs'
import { clearedState, decideTick, initialState, matchBareCommand, parseCommandAliases, parseTargets, splitLegacyTargets, RETRY_INTERVAL_MS } from '../lib/schedule.mjs'
import { locateArticle, matchToday, parseLinkPage, parseResults, searchPageUrl } from '../lib/sogou.mjs'
import { BROWSER_HINT, resolveCalendar, sourceLabel, traceText } from '../lib/source.mjs'
import { beijing, titleMatches } from '../lib/time.mjs'
import { readBodyTail } from '../lib/http.mjs'
import { createModule, readJsonBody, sameOriginRequest } from '../index.mjs'

const DAY = '2026-11-19T08:10:00+08:00'
const STAMP = beijing(new Date(DAY))
const TS = Math.floor(Date.parse('2026-11-19T07:30:00+08:00') / 1000)
const PNG = Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), Buffer.alloc(8)])
const JPEG = Buffer.concat([Buffer.from([255, 216, 255, 219]), Buffer.alloc(8)])
const WEBP = Buffer.concat([Buffer.from('RIFF'), Buffer.alloc(4), Buffer.from('WEBP')])

const settings = { daily: true, time: '08:00', deadline: '12:00' }

function htmlResponse(body, url, cookies = []) {
  return {
    ok: true,
    status: 200,
    url,
    headers: {
      get: name => (String(name).toLowerCase() === 'content-type' ? 'text/html; charset=utf-8' : null),
      getSetCookie: () => cookies,
    },
    arrayBuffer: async () => new TextEncoder().encode(body).buffer,
  }
}

function bytesResponse(bytes, url) {
  return {
    ok: true,
    status: 200,
    url,
    headers: { get: () => null, getSetCookie: () => [] },
    arrayBuffer: async () => Uint8Array.from(bytes).buffer,
  }
}

// 分块给的流式响应；declared 是响应头里声明的长度，可以和实际不一致。
function streamResponse(chunks, url, declared = 0) {
  return {
    ok: true,
    status: 200,
    url,
    headers: { get: name => (String(name).toLowerCase() === 'content-length' ? String(declared) : null), getSetCookie: () => [] },
    body: new ReadableStream({ start(controller) { for (const chunk of chunks) controller.enqueue(chunk); controller.close() } }),
  }
}

function searchHtml(ts = TS) {
  return `<div>
    <h3><a href="/link?url=other&amp;type=2">11月19日今天你摸鱼了吗?</a></h3>
    <span class="all-time-y2">打工日历</span><script>timeConvert('${ts}')</script>
    <h3><a href="/link?url=yesterday">[<em>摸鱼人日历</em>]11月18号 今天你摸鱼了吗?</a></h3>
    <span class="all-time-y2">摸鱼人日历</span><script>timeConvert('${ts - 86400}')</script>
    <h3><a href="/link?url=today&amp;k=1">[摸鱼人日历]11月19号 今天你摸鱼了吗?&middot;周四</a></h3>
    <span class="all-time-y2">摸鱼人日历</span><script>timeConvert('${ts}')</script>
  </div>`
}

const LINK_HTML = `<script>
    url += 'https://mp.';
    url += 'weixin.qq.com/s?src=11&timestamp=1&signature=abc';
    url.replace("@", "");
    window.location.replace(url)
</script>`

function rssXml(pubDate) {
  return `<?xml version="1.0"?><rss version="2.0"><channel><title>摸鱼人日历</title>
    <item>
      <title><![CDATA[[摸鱼人日历]11月19号 今天你摸鱼了吗？]]></title>
      <link>https://mp.weixin.qq.com/s?__biz=example</link>
      <pubDate>${pubDate}</pubDate>
      <description>只有一段文字</description>
      <content:encoded><![CDATA[<p><img data-src="https://mmbiz.qpic.cn/sz_mmbiz_png/abc/640?wx_fmt=png&amp;from=appmsg" data-w="540" data-ratio="1.49" /></p>]]></content:encoded>
    </item>
  </channel></rss>`
}

const ALBUM_URL = albumListUrl()
const ALBUM_LIST = /\/mp\/appmsgalbum\?/
const ARTICLE_URL = 'https://mp.weixin.qq.com/s?__biz=example&mid=19&idx=3&sn=new'
const ARTICLE_HTML = `<html><head><title>微信公众平台</title></head><body>
  <div id="activity-name">[摸鱼人日历]11月19号 今天你摸鱼了吗？</div>
  <img data-src="https://mmbiz.qpic.cn/mmbiz_png/abc/640?wx_fmt=png&amp;from=appmsg" data-w="540" data-ratio="1.4889">
  <script>
    var biz = "MzAxOTYyMzczNA==";
    var msg_title = '[摸鱼人日历]11月19号 今天你摸鱼了吗？'.html(false);
    var nickname = htmlDecode("摸鱼人日历");
    var ct = "${TS}"
  </script></body></html>`

// 每条的时间戳是几点，标题就写几号。
function albumJson(dates = [TS]) {
  const list = dates.map((ts, i) => {
    const { month, day } = beijing(new Date(ts * 1000))
    return {
      title: `[摸鱼人日历]${month}月${day}号 今天你摸鱼了吗？`,
      create_time: String(ts),
      url: `http://mp.weixin.qq.com/s?__biz=example&mid=${19 + i}&idx=3&sn=${i}#rd`,
    }
  })
  return JSON.stringify({ base_resp: { ret: 0, errmsg: '' }, getalbum_resp: { continue_flag: '1', article_list: list } })
}

let pubDate = ''
before(() => { pubDate = new Date('2026-11-19T07:30:00+08:00').toUTCString() })

test('标题日期：补零、号/日，以及 1 号不会命中 11 号', () => {
  assert.equal(titleMatches('[摸鱼人日历]11月19号 今天你摸鱼了吗？', STAMP), true)
  assert.equal(titleMatches('[摸鱼人日历]11月19日', STAMP), true)
  assert.equal(titleMatches('[摸鱼人日历]05月07号', { date: '2026-05-07' }), true)
  assert.equal(titleMatches('[摸鱼人日历]11月18号', STAMP), false)
  assert.equal(titleMatches('11月19号 今天你摸鱼了吗？', STAMP), false, '没有栏目名的标题不算')
  assert.equal(titleMatches('[摸鱼人日历]11月11号', { date: '2026-11-01' }), false)
  assert.equal(titleMatches('[摸鱼人日历]11月1号', { date: '2026-11-11' }), false)
})

test('搜狗结果：丢掉同类号和日期对不上的条目', () => {
  const items = parseResults(searchHtml())
  assert.equal(items.length, 3)
  assert.equal(items[2].account, '摸鱼人日历')
  assert.match(items[2].title, /\[摸鱼人日历\]11月19号/)
  assert.equal(items[2].title.includes('·'), true)
  assert.equal(items[2].href, '/link?url=today&k=1')
  const hit = matchToday(items, STAMP)
  assert.equal(hit.href, '/link?url=today&k=1')
  assert.equal(matchToday(items, beijing(new Date('2026-11-18T08:00:00+08:00'))).href, '/link?url=yesterday')
})

test('搜狗跳转页拼出微信文章地址，别的站点不要', () => {
  const url = parseLinkPage(LINK_HTML)
  assert.equal(url, 'https://mp.weixin.qq.com/s?src=11&timestamp=1&signature=abc')
  assert.equal(parseLinkPage(`url += 'https://evil.example/s?x=1';`), '')
  assert.match(searchPageUrl(STAMP), /weixin\.sogou\.com\/weixin\?type=2&query=/)
})

test('定位文章时带上搜狗下发的 Cookie 和 Referer', async () => {
  const seen = []
  const fetchImpl = async (url, opts) => {
    seen.push({ url: String(url), cookie: opts.headers.cookie || '', referer: opts.headers.referer || '' })
    if (String(url).includes('/weixin?')) return htmlResponse(searchHtml(), String(url), ['SUID=s1; Path=/'])
    return htmlResponse(LINK_HTML, String(url))
  }
  const found = await locateArticle(STAMP, { fetchImpl })
  assert.equal(found.ok, true)
  assert.match(found.articleUrl, /^https:\/\/mp\.weixin\.qq\.com\/s\?/)
  assert.equal(seen[1].cookie, 'SUID=s1')
  assert.match(seen[1].referer, /^https:\/\/weixin\.sogou\.com\/weixin\?/)
})

test('普通请求遇到搜狗验证页时改用浏览器搜索', async () => {
  let url = ''
  const browser = {
    launch: async () => ({ ok: true }),
    navigate: async (next) => { url = String(next); return { ok: true, url } },
    evaluate: async (expr) => {
      const code = String(expr)
      if (code.includes('location.href')) return url.includes('/link') ? 'https://mp.weixin.qq.com/s?src=11&signature=abc' : url
      if (code.includes('documentElement')) {
        if (url.includes('/weixin?')) return searchHtml()
        if (url.includes('/link')) return LINK_HTML
        return ''
      }
      return {
        blocked: false,
        heading: '[摸鱼人日历]11月19号 今天你摸鱼了吗？',
        title: '[摸鱼人日历]11月19号 今天你摸鱼了吗？',
        nickname: '摸鱼人日历',
        ct: TS,
        imgs: [{ src: 'https://mmbiz.qpic.cn/cal/640?wx_fmt=png', w: 540, ratio: 1.49 }],
      }
    },
  }
  const result = await resolveCalendar({
    stamp: STAMP,
    fetchImpl: async () => htmlResponse('<html>antispider 请输入验证码</html>', 'https://weixin.sogou.com/weixin?type=2'),
    browser,
    sleep: async () => {},
    attempts: 2,
    intervalMs: 0,
  })
  assert.equal(result.ok, true, result.error)
  assert.match(result.imageUrl, /mmbiz\.qpic\.cn\/cal\//)
  assert.match(result.articleUrl, /^https:\/\/mp\.weixin\.qq\.com\/s\?/)
})

test('搜狗验证页不算「今天没有」', async () => {
  const fetchImpl = async () => htmlResponse('<html>antispider 请输入验证码</html>', 'https://weixin.sogou.com/weixin?type=2')
  const found = await locateArticle(STAMP, { fetchImpl })
  assert.equal(found.ok, false)
  assert.equal(found.missing, false)
  assert.match(found.error, /验证/)
})

test('搜狗空页面不算「今天没有」', async () => {
  const found = await locateArticle(STAMP, { fetchImpl: async url => htmlResponse('', String(url)) })
  assert.equal(found.ok, false)
  assert.equal(found.missing, false)
  assert.match(found.error, /空页面/)
})

test('合集：解析列表、挑出今天的文章，只认微信文章地址', () => {
  const album = parseAlbum(albumJson([TS - 86400, TS]))
  assert.equal(album.ok, true)
  assert.match(albumListUrl(), /mp\.weixin\.qq\.com\/mp\/appmsgalbum\?action=getalbum&__biz=MzAxOTYyMzczNA==&album_id=3743225907507462153/)
  const hit = findTodayArticle(album.items, STAMP)
  assert.match(hit.title, /11月19号/)
  assert.equal(articleUrl(hit.url), 'https://mp.weixin.qq.com/s?__biz=example&mid=20&idx=3&sn=1')
  assert.equal(findTodayArticle(album.items, beijing(new Date('2026-11-18T08:00:00+08:00'))).title.includes('11月18号'), true)
  assert.equal(articleUrl('http://mp.weixin.qq.com/s?__biz=example'), 'https://mp.weixin.qq.com/s?__biz=example')
  assert.equal(articleUrl('https://evil.example/s?x=1'), '')
  assert.equal(articleUrl('https://mp.weixin.qq.com/mp/profile_ext?action=home'), '')
  assert.equal(parseAlbum('<html>empty</html>').ok, false)
  assert.equal(parseAlbum(JSON.stringify({ base_resp: { ret: -3, errmsg: 'invalid' } })).ok, false)
  assert.equal(parseAlbum(JSON.stringify({ base_resp: { ret: 0 } })).ok, false)
  const meta = articleMeta(ARTICLE_HTML)
  assert.deepEqual(meta, { nickname: '摸鱼人日历', title: '[摸鱼人日历]11月19号 今天你摸鱼了吗？', ct: TS })
  assert.deepEqual(articleMeta('<html></html>'), { nickname: '', title: '', ct: 0 })
})

test('合集取图：普通请求就够，不需要浏览器；环境异常不算缺失', async () => {
  const seen = []
  const fetchImpl = async (url) => {
    seen.push(String(url))
    if (ALBUM_LIST.test(String(url))) return htmlResponse(albumJson([TS - 86400, TS]), String(url))
    return htmlResponse(ARTICLE_HTML, String(url))
  }
  const ok = await calendarFromAlbum(STAMP, { fetchImpl })
  assert.equal(ok.ok, true, ok.error)
  assert.equal(ok.source, 'album')
  assert.match(ok.imageUrl, /mmbiz\.qpic\.cn\/mmbiz_png\/abc\/640/)
  assert.equal(ok.articleUrl, 'https://mp.weixin.qq.com/s?__biz=example&mid=20&idx=3&sn=1')
  assert.equal(seen[0], ALBUM_URL)
  assert.equal(seen[1], 'https://mp.weixin.qq.com/s?__biz=example&mid=20&idx=3&sn=1')

  const none = await calendarFromAlbum(STAMP, { fetchImpl: async url => htmlResponse(albumJson([TS - 86400]), String(url)) })
  assert.equal(none.ok, false)
  assert.equal(none.missing, true)
  assert.match(none.error, /合集里还没有/)

  const blocked = await calendarFromAlbum(STAMP, {
    fetchImpl: async url => htmlResponse(ALBUM_LIST.test(String(url)) ? albumJson() : '<html>环境异常</html>', String(url)),
  })
  assert.equal(blocked.missing, false)
  assert.match(blocked.error, /环境异常/)

  const other = await calendarFromAlbum(STAMP, {
    fetchImpl: async url => htmlResponse(ALBUM_LIST.test(String(url)) ? albumJson() : ARTICLE_HTML.replace('htmlDecode("摸鱼人日历")', 'htmlDecode("打工日历")'), String(url)),
  })
  assert.equal(other.ok, false)
  assert.match(other.error, /打工日历/)
})

test('来源：合集成功就不走搜狗；合集出错或没有今天的文章时回落到搜狗', async () => {
  const fromAlbum = await resolveCalendar({
    stamp: STAMP,
    fetchImpl: async (url) => {
      const target = String(url)
      if (target === ALBUM_URL) return htmlResponse(albumJson(), target)
      if (target.startsWith('https://mp.weixin.qq.com/s?')) return htmlResponse(ARTICLE_HTML, target)
      throw new Error(`不该请求 ${target}`)
    },
    browserOf: () => { throw new Error('合集成功时不该用浏览器') },
  })
  assert.equal(fromAlbum.ok, true, fromAlbum.error)
  assert.equal(fromAlbum.source, 'album')

  const fellBack = await resolveCalendar({
    stamp: STAMP,
    fetchImpl: async (url) => {
      const target = String(url)
      if (ALBUM_LIST.test(target)) return htmlResponse('<html>empty</html>', target)
      if (target.includes('/weixin?')) return htmlResponse(searchHtml(), target)
      return htmlResponse(LINK_HTML, target)
    },
    // 搜狗这条路要用逛网页打开文章。
    browser: {
      launch: async () => ({ ok: true }),
      navigate: async () => ({ ok: true }),
      evaluate: async () => ({
        blocked: false,
        title: '[摸鱼人日历]11月19号 今天你摸鱼了吗？',
        nickname: '摸鱼人日历',
        ct: TS,
        imgs: [{ src: 'https://mmbiz.qpic.cn/cal/640?wx_fmt=png', w: 540, ratio: 1.49 }],
      }),
    },
  })
  assert.equal(fellBack.ok, true, fellBack.error)
  assert.equal(fellBack.source, 'sogou')
  assert.match(fellBack.imageUrl, /mmbiz\.qpic\.cn\/cal\//)

  const noArticle = await resolveCalendar({
    stamp: STAMP,
    fetchImpl: async (url) => {
      const target = String(url)
      if (ALBUM_LIST.test(target)) return htmlResponse(albumJson([TS - 86400]), target)
      return htmlResponse('<html><body>没有结果</body></html>', target)
    },
  })
  assert.equal(noArticle.ok, false)
  assert.equal(noArticle.missing, true)
  assert.match(noArticle.error, /合集里还没有/)
  assert.match(noArticle.error, /搜狗还没有/)

  const broken = await resolveCalendar({
    stamp: STAMP,
    fetchImpl: async (url) => {
      const target = String(url)
      if (ALBUM_LIST.test(target)) return { ok: false, status: 500, url: target, headers: { get: () => null, getSetCookie: () => [] } }
      return htmlResponse('<html><body>没有结果</body></html>', target)
    },
  })
  assert.equal(broken.missing, false)
  assert.match(broken.error, /微信 HTTP 500/)
})

test('文章图：竖版优先，gif 和转义正文也能认', () => {
  const html = [
    '<img data-src="https://mmbiz.qpic.cn/banner/640?wx_fmt=png" data-w="900" data-ratio="0.42">',
    '<img data-src="https://mmbiz.qpic.cn/face/640?wx_fmt=gif" data-w="400" data-ratio="1">',
    '<img data-src="https://mmbiz.qpic.cn/cal/640?wx_fmt=png" data-w="540" data-ratio="1.49">',
  ].join('')
  assert.match(pickCalendarImage(imagesFromHtml(html)), /\/cal\/640/)
  const escaped = '&lt;img data-src=&quot;https://mmbiz.qpic.cn/cal/640?wx_fmt=png&amp;from=appmsg&quot; data-w=&quot;540&quot; data-ratio=&quot;1.49&quot;&gt;'
  assert.match(pickCalendarImage(imagesFromHtml(escaped)), /mmbiz\.qpic\.cn\/cal\/640/)
  assert.equal(pickCalendarImage(imagesFromHtml('<img src="https://example.com/a.png">')), '')
  assert.match(decodeBasic('[<em>摸鱼人日历</em>]&middot;'), /\[摸鱼人日历\]·/)
  assert.match(ARTICLE_EXPR, /环境异常/)
  assert.equal(ARTICLE_EXPR.includes('eval('), false)
})

test('文章页先是验证、随后出图；一直验证则失败', async () => {
  const pages = [
    { blocked: true, title: '', imgs: [] },
    { blocked: false, title: '[摸鱼人日历]11月19号', nickname: '摸鱼人日历', ct: TS, imgs: [{ src: 'https://mmbiz.qpic.cn/cal/640?wx_fmt=png', w: 540, ratio: 1.49 }] },
  ]
  let sleeps = 0
  const ok = await readArticle({ evaluate: async () => pages.shift() }, { attempts: 2, intervalMs: 5, sleep: async () => { sleeps += 1 } })
  assert.equal(ok.ok, true)
  assert.match(ok.image, /\/cal\/640/)
  assert.equal(sleeps, 1)
  const blocked = await readArticle({ evaluate: async () => ({ blocked: true, imgs: [] }) }, { attempts: 2, intervalMs: 0, sleep: async () => {} })
  assert.equal(blocked.ok, false)
  assert.match(blocked.error, /环境异常/)
})

test('标签页还停在昨天时，等到今天的标题再取图', async () => {
  const pages = [
    { blocked: false, title: '[摸鱼人日历]11月22号 今天你摸鱼了吗？', nickname: '摸鱼人日历', ct: 1, imgs: [{ src: 'https://mmbiz.qpic.cn/old/640?wx_fmt=png', w: 540, ratio: 1.49 }] },
    { blocked: false, heading: '[摸鱼人日历]11月23号 今天你摸鱼了吗？', title: '微信公众平台', nickname: '摸鱼人日历', ct: 2, imgs: [{ src: 'https://mmbiz.qpic.cn/new/640?wx_fmt=png', w: 540, ratio: 1.49 }] },
  ]
  const ok = await readArticle({ evaluate: async () => pages.shift() }, {
    attempts: 3,
    intervalMs: 0,
    sleep: async () => {},
    accept: (page) => String(page.title).includes('11月23号'),
  })
  assert.equal(ok.ok, true)
  assert.match(ok.title, /11月23号/)
  assert.match(ok.image, /\/new\//)
})

test('RSS 取今天的图；没有今天的条目算缺失，内网地址拒绝', async () => {
  const feed = parseFeed(rssXml(pubDate))
  assert.equal(feed.ok, true)
  const entry = findToday(feed.items, STAMP)
  assert.ok(entry)
  assert.match(pickCalendarImage(imagesFromHtml(entry.html)), /\/abc\/640/)
  const fetched = await calendarFromRss('https://8.8.8.8/moyu', STAMP, {
    fetchImpl: async () => htmlResponse(rssXml(pubDate), 'https://8.8.8.8/moyu'),
  })
  assert.equal(fetched.ok, true)
  assert.equal(fetched.source, 'rss')
  const old = parseFeed(rssXml(new Date('2026-11-18T07:30:00+08:00').toUTCString()))
  assert.equal(findToday(old.items, STAMP), null)
  await assert.rejects(assertPublicHttp('http://127.0.0.1/rss'), /本机|内网/)
  await assert.rejects(assertPublicHttp('http://10.1.2.3/rss'), /内网/)
  await assert.rejects(assertPublicHttp('http://192.168.1.8/rss'), /内网/)
  await assert.rejects(assertPublicHttp('https://user:pass@8.8.8.8/moyu'), /HTTP\(S\)/)
  assert.match(await assertPublicHttp('https://8.8.8.8/rss'), /^https:\/\/8\.8\.8\.8\/rss/)
  await assert.rejects(assertPublicHttp('http://localhost/rss'), /本机/)

  // 打开「允许内网 RSS」后放行本机和内网，协议与账号密码的限制不变。
  assert.match(await assertPublicHttp('http://192.168.1.8/rss', { allowPrivate: true }), /^http:\/\/192\.168\.1\.8\/rss$/)
  assert.match(await assertPublicHttp('http://127.0.0.1/rss', { allowPrivate: true }), /^http:\/\/127\.0\.0\.1\/rss$/)
  await assert.rejects(assertPublicHttp('https://user:pass@192.168.1.8/moyu', { allowPrivate: true }), /HTTP\(S\)/)
  await assert.rejects(assertPublicHttp('ftp://192.168.1.8/a', { allowPrivate: true }), /HTTP\(S\)/)

  const lan = 'http://192.168.1.8/moyu'
  const lanFetch = async url => htmlResponse(rssXml(pubDate), String(url))
  const refused = await calendarFromRss(lan, STAMP, { fetchImpl: lanFetch })
  assert.equal(refused.ok, false)
  assert.equal(refused.missing, false)
  assert.match(refused.error, /内网/)
  const allowed = await calendarFromRss(lan, STAMP, { fetchImpl: lanFetch, allowPrivate: true })
  assert.equal(allowed.ok, true, allowed.error)
  assert.equal(allowed.source, 'rss')
  // 重定向跳到内网也算。
  const redirectedLan = await calendarFromRss('https://8.8.8.8/moyu', STAMP, {
    fetchImpl: async () => htmlResponse(rssXml(pubDate), 'http://192.168.1.8/moyu'),
  })
  assert.match(redirectedLan.error, /内网/)
})

test('RSS 输出全文、图片在 RSS 自己的服务器上时也能取到图', async () => {
  const LAN = 'http://192.168.1.8:5200'
  const own = `${LAN}/api/articles/serve-file/%E6%91%B8/media/img_003.png`
  const proxied = `<?xml version="1.0"?><rss version="2.0"><channel><title>摸鱼人日历</title>
    <item>
      <title><![CDATA[[摸鱼人日历]11月19号 今天你摸鱼了吗？]]></title>
      <link>${LAN}/a.html</link>
      <pubDate>${pubDate}</pubDate>
      <content:encoded><![CDATA[<p><img data-src="${own}" data-w="540" data-ratio="1.49" /></p>]]></content:encoded>
    </item>
  </channel></rss>`
  // 全文的 RSS 很大，we-mp-rss 30 条就有 2MB 多，不能按 2MB 卡。
  const huge = proxied.replace('</content:encoded>', `<p>${'全文'.repeat(1_200_000)}</p></content:encoded>`)
  assert.ok(huge.length > 2_000_000)
  const fetched = await calendarFromRss(`${LAN}/rss`, STAMP, {
    allowPrivate: true,
    fetchImpl: async url => htmlResponse(huge, String(url)),
  })
  assert.equal(fetched.ok, true, fetched.error)
  assert.equal(fetched.source, 'rss')
  assert.equal(fetched.imageUrl, own)
  assert.equal(fetched.imageOrigin, LAN)

  const img = await downloadImage(fetched.imageUrl, {
    allowedOrigin: fetched.imageOrigin,
    fetchImpl: async url => bytesResponse(PNG, String(url)),
  })
  assert.equal(img.ok, true, img.error)
  // 只认 RSS 自己的站点：别的站点不要，重定向到别处也不要，没给来源也不要。
  assert.equal(await downloadImage(own, { fetchImpl: async () => bytesResponse(PNG, own) }).then(r => r.ok), false)
  assert.equal(await downloadImage('https://evil.example/a.png', { allowedOrigin: LAN, fetchImpl: async () => bytesResponse(PNG, 'x') }).then(r => r.ok), false)
  assert.equal(await downloadImage(own, { allowedOrigin: LAN, fetchImpl: async () => bytesResponse(PNG, 'https://evil.example/a.png') }).then(r => r.ok), false)
  assert.equal(feedOrigin(`${LAN}/rss`), LAN)

  const entry = { html: `<img data-src="${own}" data-w="540" data-ratio="1.49"><img data-src="https://evil.example/a.png" data-w="900" data-ratio="1.5">` }
  assert.equal(imageFromEntry(entry, LAN), own)
  assert.equal(imageFromEntry(entry), '', '没给来源时不认 RSS 服务器上的图')
  assert.equal(imageFromEntry(entry, 'http://192.168.1.9:5200'), '')
  assert.match(imageFromEntry({ html: rssXml(pubDate).match(/<img[^>]*>/)[0] }, ''), /\/abc\/640/)
})

test('RSS 超过 10MB：只保留末尾 10MB 找今天的文章，并在来源里注明', async () => {
  const LAN = 'http://192.168.1.8:5200'
  const head = '<?xml version="1.0"?><rss version="2.0"><channel><title>摸鱼人日历</title>'
  const today = rssXml(pubDate).match(/<item>[\s\S]*<\/item>/)[0]
  const tail = '</channel></rss>'
  const mega = () => Buffer.alloc(1_000_000, 0x61)
  const opts = { allowPrivate: true }

  // 今天的文章排在最后，前面有 11MB 往期：开头的往期被丢掉，今天的照样取到，响应头声明的长度再大也不拦。
  const last = await calendarFromRss(`${LAN}/rss`, STAMP, {
    ...opts,
    fetchImpl: async url => streamResponse([Buffer.from(head), ...Array.from({ length: 11 }, mega), Buffer.from(today + tail)], String(url), 12_000_000),
  })
  assert.equal(last.ok, true, last.error)
  assert.equal(last.imageUrl, 'https://mmbiz.qpic.cn/sz_mmbiz_png/abc/640?wx_fmt=png&from=appmsg')
  assert.equal(last.note, '超过 10MB，只保留末尾 10MB')

  // 没超过时和以前一样，不带说明。
  const small = await calendarFromRss(`${LAN}/rss`, STAMP, { ...opts, fetchImpl: async url => htmlResponse(rssXml(pubDate), String(url)) })
  assert.equal(small.ok, true, small.error)
  assert.equal(small.note, '')
  assert.equal(traceText((await resolveCalendar({ stamp: STAMP, rssUrl: `${LAN}/rss`, rssAllowPrivate: true, fetchImpl: async url => htmlResponse(rssXml(pubDate), String(url)) })).trace), 'RSS：成功')

  // 今天的文章排在最前面、后面还有 10MB 以上：它被丢掉了，算失败并接着试合集，不算「今天没有」。
  const first = await calendarFromRss(`${LAN}/rss`, STAMP, {
    ...opts,
    fetchImpl: async url => streamResponse([Buffer.from(head + today), ...Array.from({ length: 11 }, mega), Buffer.from(tail)], String(url)),
  })
  assert.equal(first.ok, false)
  assert.equal(first.missing, false)
  assert.match(first.error, /超过 10MB，末尾 10MB 里没有今天的摸鱼人日历/)

  // 没有流式 body、只能一次读完的响应也一样。
  const whole = await calendarFromRss(`${LAN}/rss`, STAMP, {
    ...opts,
    fetchImpl: async url => htmlResponse(head + 'a'.repeat(10_100_000) + today + tail, String(url)),
  })
  assert.equal(whole.ok, true, whole.error)
  assert.equal(whole.note, '超过 10MB，只保留末尾 10MB')

  // 日志里能看到 RSS 太大被截断过。
  const resolved = await resolveCalendar({
    stamp: STAMP,
    rssUrl: `${LAN}/rss`,
    rssAllowPrivate: true,
    fetchImpl: async url => streamResponse([Buffer.from(head), ...Array.from({ length: 11 }, mega), Buffer.from(today + tail)], String(url)),
  })
  assert.equal(resolved.ok, true, resolved.error)
  assert.equal(resolved.source, 'rss')
  assert.equal(traceText(resolved.trace), 'RSS：成功（超过 10MB，只保留末尾 10MB）')

  // 读响应这一步：每块 6 字节、最多留 10 字节、累计 25 字节就停。读了 5 块（A 到 E）后停下，留的是末尾 10 字节。
  const letters = from => Array.from({ length: 10 }, (_, i) => Buffer.alloc(6, from + i))
  const cut = await readBodyTail(streamResponse(letters(65), 'x'), 10, 25)
  assert.equal(cut.bytes.toString(), 'DDDDEEEEEE')
  assert.equal(cut.truncated, true)
  // 刚好不超时不算截断。
  const exact = await readBodyTail(streamResponse(letters(65).slice(0, 3), 'x'), 18, 25)
  assert.equal(exact.bytes.toString(), 'AAAAAABBBBBBCCCCCC')
  assert.equal(exact.truncated, false)
})

test('定时：内网 RSS 默认被拒，打开「允许内网 RSS」后才使用', async () => {
  const lan = 'http://192.168.1.8/moyu'
  const run = async (rssAllowPrivate) => {
    const dataRoot = mkdtempSync(join(tmpdir(), 'moyu-lan-'))
    let current = Date.parse('2026-11-19T07:00:00+08:00')
    const mod = createModule({
      now: () => current,
      fetchImpl: async (url) => {
        if (String(url).startsWith(lan)) return htmlResponse(rssXml(pubDate), String(url))
        if (String(url).includes('mmbiz.qpic.cn')) return bytesResponse(PNG, String(url))
        throw new Error(`不该请求 ${url}`)
      },
    })
    const { api, sent } = makeApi(dataRoot, { settings: { rssUrl: lan, rssAllowPrivate } })
    const { tick, status } = await mod.setup(api)
    // 装好时还没到点，到点后才会去取图。
    current = Date.parse('2026-11-19T08:10:00+08:00')
    await tick()
    return { sent, status }
  }
  const off = await run(false)
  assert.equal(off.sent.length, 0)
  assert.match(off.status().lastError, /内网/)
  const unset = await run(undefined)
  assert.equal(unset.sent.length, 0)
  const on = await run(true)
  assert.equal(on.sent.filter(item => item.type === 'image').length, 1)
  assert.equal(on.status().source, 'rss')
  assert.equal(on.status().state.completed, '2026-11-19')
})

test('原图地址、魔数和大小上限', async () => {
  assert.equal(originalImageUrl('https://mmbiz.qpic.cn/sz_mmbiz_png/abc/640?wx_fmt=png&from=appmsg'), 'https://mmbiz.qpic.cn/sz_mmbiz_png/abc/0?wx_fmt=png&from=appmsg')
  assert.equal(originalImageUrl('https://mmbiz.qpic.cn/a/300?wx_fmt=jpeg#img'), 'https://mmbiz.qpic.cn/a/0?wx_fmt=jpeg')
  assert.equal(originalImageUrl('https://example.com/a/640'), '')
  assert.equal(originalImageUrl('http://mmbiz.qpic.cn/a/640'), '')
  assert.equal(detectMime(PNG), 'image/png')
  assert.equal(detectMime(JPEG), 'image/jpeg')
  assert.equal(detectMime(WEBP), 'image/webp')
  assert.equal(detectMime(Buffer.from('not an image!!')), '')
  const ok = await downloadImage('https://mmbiz.qpic.cn/a/640?wx_fmt=png', {
    fetchImpl: async url => bytesResponse(PNG, String(url)),
  })
  assert.equal(ok.ok, true)
  assert.match(ok.mime, /png/)
  const huge = await downloadImage('https://mmbiz.qpic.cn/a/0', {
    maxBytes: 8,
    fetchImpl: async url => bytesResponse(PNG, String(url)),
  })
  assert.equal(huge.ok, false)
  assert.match(huge.error, /大小限制/)
  const redirected = await downloadImage('https://mmbiz.qpic.cn/a/0', {
    fetchImpl: async () => bytesResponse(PNG, 'https://evil.example/a.png'),
  })
  assert.match(redirected.error, /重定向/)
})

test('缓存按日期读写，坏文件删掉，旧图清理', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'moyu-cache-'))
  await writeFile(join(dir, '2026-11-19.png'), Buffer.from('hello world!!'))
  assert.equal(await readCache(dir, '2026-11-19'), null)
  await writeCache(dir, '2026-11-19', PNG, 'image/png')
  const hit = await readCache(dir, '2026-11-19')
  assert.equal(hit.mime, 'image/png')
  assert.equal(detectMime(hit.bytes), 'image/png')
  await writeCache(dir, '2026-10-01', JPEG, 'image/jpeg')
  await writeFile(join(dir, 'daily-state.json'), '{}')
  await pruneCache(dir, 14, Date.parse('2026-11-19T00:00:00+08:00'))
  assert.equal(await readCache(dir, '2026-11-19') !== null, true)
  assert.equal(await readCache(dir, '2026-10-01'), null)
  assert.equal(await readFile(join(dir, 'daily-state.json'), 'utf8'), '{}')
})

test('定时判断：未到点、重试间隔、截止放弃、有图仍补发', () => {
  const base = {
    stamp: { ...STAMP, time: '09:00' },
    settings,
    state: { date: STAMP.date, attempts: 0, lastAttempt: 0, sent: [], completed: '', noUpdate: '', firstSkip: '' },
    enabled: true,
    dryRun: false,
    busy: false,
    nowMs: 2_000_000_000_000,
    hasImage: false,
  }
  assert.equal(decideTick({ ...base, stamp: { ...base.stamp, time: '07:30' } }).action, 'skip')
  assert.equal(decideTick({ ...base, enabled: false }).reason, 'paused')
  assert.equal(decideTick({ ...base, dryRun: true }).reason, 'paused')
  assert.equal(decideTick({ ...base, settings: { ...settings, daily: false } }).reason, 'daily-off')
  assert.equal(decideTick({ ...base, state: { ...base.state, firstSkip: STAMP.date } }).reason, 'settled')
  assert.equal(decideTick({ ...base, state: { ...base.state, completed: STAMP.date } }).reason, 'settled')
  assert.equal(decideTick(base).action, 'fetch')
  const tried = { ...base.state, attempts: 1, lastAttempt: base.nowMs - 1000 }
  assert.equal(decideTick({ ...base, state: tried }).reason, 'retry-wait')
  assert.equal(decideTick({ ...base, state: { ...tried, lastAttempt: base.nowMs - RETRY_INTERVAL_MS } }).action, 'fetch')
  assert.equal(decideTick({
    ...base,
    stamp: { ...base.stamp, time: '12:00' },
    state: tried,
  }).action, 'giveup')
  assert.equal(decideTick({
    ...base,
    stamp: { ...base.stamp, time: '13:00' },
    state: { ...tried, sent: ['private:1'] },
    hasImage: true,
    nowMs: tried.lastAttempt + RETRY_INTERVAL_MS,
  }).action, 'deliver')
  assert.equal(decideTick({ ...base, settings: { ...settings, deadline: '08:00' } }).reason, '截止时间要晚于开始时间')
  assert.equal(decideTick({ ...base, settings: { ...settings, time: '8点' } }).action, 'error')
  assert.equal(initialState({ date: STAMP.date, time: '10:00' }, settings).firstSkip, STAMP.date)
  assert.equal(initialState({ date: STAMP.date, time: '07:00' }, settings).firstSkip, '')
  assert.deepEqual(parseCommandAliases('摸鱼日历\n/摸鱼\n摸鱼人日历，摸鱼人日历 /帮助'), ['摸鱼日历', '摸鱼', '摸鱼人日历'])
  assert.deepEqual(matchBareCommand('摸鱼人日历', ['摸鱼', '摸鱼人日历']), { arg: '' })
  assert.deepEqual(matchBareCommand('摸鱼人日历状态', ['摸鱼', '摸鱼人日历']), { arg: '状态' })
  assert.equal(matchBareCommand('/摸鱼人日历', ['摸鱼人日历']), null)
  assert.equal(matchBareCommand('今天摸鱼人日历真好', ['摸鱼人日历']), null)
  assert.deepEqual(parseCommandAliases('状态 moyu'), [])
  assert.deepEqual(parseTargets('', '', '10000'), ['private:10000'])
  assert.deepEqual(parseTargets('10001\n10001', '200', ''), ['private:10001', 'group:200'])
  assert.deepEqual(parseTargets('', '200', '10000'), ['private:10000', 'group:200'])
  assert.deepEqual(splitLegacyTargets('group:200，private:10001'), { privateChats: '10001', groupChats: '200' })
  assert.throws(() => parseTargets('everybody', '', ''), /私聊 QQ 号/)
})

test('来源：RSS 成功就不再开浏览器；没有浏览器时说明白', async () => {
  let opened = false
  const rss = await resolveCalendar({
    stamp: STAMP,
    rssUrl: 'https://8.8.8.8/moyu',
    fetchImpl: async (url) => {
      if (String(url).includes('8.8.8.8')) return htmlResponse(rssXml(pubDate), String(url))
      throw new Error(`不该请求 ${url}`)
    },
    browser: { launch: async () => { opened = true; return { ok: true } }, navigate: async () => ({ ok: true }), evaluate: async () => ({}) },
  })
  assert.equal(rss.ok, true)
  assert.equal(rss.source, 'rss')
  assert.equal(opened, false)

  const noBrowser = await resolveCalendar({
    stamp: STAMP,
    fetchImpl: async (url) => {
      if (String(url).includes('/weixin?')) return htmlResponse(searchHtml(), String(url))
      return htmlResponse(LINK_HTML, String(url))
    },
    browser: null,
  })
  assert.equal(noBrowser.ok, false)
  assert.equal(noBrowser.error, BROWSER_HINT)

  const whitelist = await resolveCalendar({
    stamp: STAMP,
    attempts: 1,
    fetchImpl: async (url) => String(url).includes('/weixin?') ? htmlResponse(searchHtml(), String(url)) : htmlResponse(LINK_HTML, String(url)),
    browser: {
      launch: async () => ({ ok: true }),
      navigate: async () => ({ ok: false, message: '站点不在白名单：https://mp.weixin.qq.com/s' }),
      evaluate: async () => { throw new Error('不该读页面') },
    },
  })
  assert.match(whitelist.error, /白名单/)
  assert.match(whitelist.error, /mp\.weixin\.qq\.com/)
})

test('来源：RSS 故障不能被搜狗的「没有」盖成今天无更新', async () => {
  const result = await resolveCalendar({
    stamp: STAMP,
    rssUrl: 'https://8.8.8.8/moyu',
    fetchImpl: async (url) => {
      if (String(url).includes('8.8.8.8')) throw new Error('down')
      return htmlResponse('<html><body>没有结果</body></html>', String(url))
    },
  })
  assert.equal(result.missing, false)
  assert.match(result.error, /RSS/)
  assert.match(result.error, /搜狗还没有/)
})

function makeApi(dataRoot, { settings: extra = {}, config = {}, sendSegments, sendText } = {}) {
  const sent = []
  const routes = {}
  let disposed = null
  const api = {
    settings: () => ({
      daily: true, time: '08:00', deadline: '12:00', privateChats: '10001', groupChats: '', rssUrl: '', caption: '来源：公众号 摸鱼人日历', ...extra,
    }),
    config: () => ({ enabled: true, dryRun: false, ownerQQ: '10000', ...config }),
    dataDir: (...parts) => join(dataRoot, ...parts),
    log: { info() {}, warn() {}, error() {} },
    command() {},
    on() {},
    route(path, fn) { routes[path] = fn },
    every() {},
    onDispose(fn) { disposed = fn },
    use: () => null,
    sendSegments: sendSegments || (async (chatId, segments) => { sent.push({ chatId, type: 'image', file: segments[0].data.file }); return { message_id: '1' } }),
    sendText: sendText || (async (chatId, text) => { sent.push({ chatId, type: 'text', text }) }),
  }
  return { api, sent, routes, dispose: () => disposed?.() }
}

test('定时：RSS 图只下一次，失败的聊天半小时后补发', async () => {
  const dataRoot = mkdtempSync(join(tmpdir(), 'moyu-tick-'))
  const calls = []
  let failGroup = true
  let current = Date.parse('2026-11-19T07:00:00+08:00')
  const mod = createModule({
    now: () => current,
    fetchImpl: async (url) => {
      calls.push(String(url))
      if (String(url).includes('8.8.8.8')) return htmlResponse(rssXml(pubDate), String(url))
      if (String(url).includes('mmbiz.qpic.cn')) {
        assert.match(String(url), /\/0\?/)
        return bytesResponse(PNG, String(url))
      }
      throw new Error(`不该请求 ${url}`)
    },
    browserOf: () => { throw new Error('RSS 成功时不该用浏览器') },
  })
  const { api, sent } = makeApi(dataRoot, {
    settings: { rssUrl: 'https://8.8.8.8/moyu', privateChats: '10001', groupChats: '200', caption: '来源：公众号 摸鱼人日历' },
    sendSegments: async (chatId) => {
      if (chatId === 'group:200' && failGroup) throw new Error('发送失败')
      sent.push({ chatId, type: 'image' })
      return { message_id: '1' }
    },
  })
  let command = null
  api.command = spec => { command = spec }
  const { tick, status } = await mod.setup(api)
  current = Date.parse('2026-11-19T08:10:00+08:00')
  await tick()
  assert.deepEqual(sent.map(item => item.chatId), ['private:10001', 'private:10001'])
  const text = await command.run('状态', { chatId: 'group:200' })
  assert.match(text, /发送失败/)
  assert.equal(text.includes('group:200'), false)
  assert.equal(text.includes('private:10001'), false)
  assert.equal(status().state.completed, '')
  assert.deepEqual(status().state.sent, ['private:10001'])
  failGroup = false
  current += 31 * 60 * 1000
  await tick()
  assert.deepEqual(sent.map(item => item.chatId), ['private:10001', 'private:10001', 'group:200', 'group:200'])
  assert.equal(status().state.completed, '2026-11-19')
  assert.equal(calls.filter(url => url.includes('mmbiz.qpic.cn')).length, 1)
  assert.equal(calls.filter(url => url.includes('8.8.8.8')).length, 1)
})

test('定时：过了截止时间仍没有文章就停止，不再请求', async () => {
  const dataRoot = mkdtempSync(join(tmpdir(), 'moyu-none-'))
  const calls = []
  let current = Date.parse('2026-11-19T07:00:00+08:00')
  const mod = createModule({
    now: () => current,
    fetchImpl: async (url) => {
      calls.push(String(url))
      // 合集里只有昨天的文章，搜狗也没有结果。
      if (ALBUM_LIST.test(String(url))) return htmlResponse(albumJson([TS - 86400]), String(url))
      return htmlResponse('<html>empty</html>', String(url))
    },
  })
  const { api } = makeApi(dataRoot)
  const { tick, status } = await mod.setup(api)
  current = Date.parse('2026-11-19T12:30:00+08:00')
  await tick()
  assert.equal(status().state.noUpdate, '2026-11-19')
  assert.match(status().lastError, /合集里还没有/)
  assert.match(status().lastError, /搜狗还没有/)
  assert.equal(calls[0], ALBUM_URL)
  const count = calls.length
  await tick()
  assert.equal(calls.length, count)
})

test('定时：首次安装已过点则今天不抓；重试间隔内不重复请求', async () => {
  const skippedRoot = mkdtempSync(join(tmpdir(), 'moyu-skip-'))
  let current = Date.parse('2026-11-19T10:00:00+08:00')
  const calls = []
  const skipped = createModule({
    now: () => current,
    fetchImpl: async (url) => { calls.push(String(url)); return htmlResponse('<html></html>', String(url)) },
  })
  const skippedApi = makeApi(skippedRoot)
  const skippedRun = await skipped.setup(skippedApi.api)
  await skippedRun.tick()
  assert.equal(calls.length, 0)
  assert.equal(skippedRun.status().state.firstSkip, '2026-11-19')

  const retryRoot = mkdtempSync(join(tmpdir(), 'moyu-retry-'))
  current = Date.parse('2026-11-19T07:00:00+08:00')
  const retryCalls = []
  const retry = createModule({
    now: () => current,
    fetchImpl: async (url) => {
      retryCalls.push(current)
      const target = String(url)
      if (ALBUM_LIST.test(target)) return htmlResponse(albumJson([TS - 86400]), target)
      return { ok: false, status: 500, url: target, headers: { get: () => null, getSetCookie: () => [] } }
    },
  })
  const { tick } = await retry.setup(makeApi(retryRoot).api)
  current = Date.parse('2026-11-19T08:10:00+08:00')
  await tick()
  current += 60 * 1000
  await tick()
  current += 30 * 60 * 1000
  await tick()
  // 每轮先读合集、再搜狗，各一次；间隔内那一轮不发请求。
  assert.equal(retryCalls.length, 4)
})

test('命令：没有逛网页时说清楚；卸载后不再发送', async () => {
  const dataRoot = mkdtempSync(join(tmpdir(), 'moyu-cmd-'))
  const mod = createModule({
    now: () => Date.parse('2026-11-19T09:00:00+08:00'),
    fetchImpl: async (url) => String(url).includes('/weixin?') ? htmlResponse(searchHtml(), String(url)) : htmlResponse(LINK_HTML, String(url)),
    browserOf: () => null,
  })
  const { api } = makeApi(dataRoot)
  let command = null
  api.command = spec => { command = spec }
  const { tick } = await mod.setup(api)
  const reply = await command.run('', { chatId: 'private:10000' })
  assert.match(reply, /逛网页|RSS/)

  const liveRoot = mkdtempSync(join(tmpdir(), 'moyu-stop-'))
  let current = Date.parse('2026-11-19T07:00:00+08:00')
  let release = null
  const started = new Promise(resolve => { release = resolve })
  const sent = []
  const live = createModule({
    now: () => current,
    fetchImpl: async (url, opts) => {
      const aborted = new Promise(resolve => {
        if (opts.signal?.aborted) resolve()
        else opts.signal?.addEventListener('abort', resolve, { once: true })
      })
      release()
      await aborted
      throw Object.assign(new Error('aborted'), { name: 'AbortError' })
    },
  })
  const liveApi = makeApi(liveRoot, {
    settings: { rssUrl: 'https://8.8.8.8/moyu' },
    sendSegments: async (chatId) => { sent.push(chatId); return { message_id: '1' } },
  })
  const running = await live.setup(liveApi.api)
  current = Date.parse('2026-11-19T08:10:00+08:00')
  const pending = running.tick()
  await started
  liveApi.dispose()
  await pending
  assert.deepEqual(sent, [])
  const again = await running.tick()
  assert.equal(again, undefined)
  assert.deepEqual(sent, [])
})

test('发图成功不再回确认句，触发词跟着设置变', async () => {
  const dataRoot = mkdtempSync(join(tmpdir(), 'moyu-quiet-'))
  await writeCache(dataRoot, '2026-11-19', PNG, 'image/png')
  const extra = { commands: '摸鱼人日历', caption: '' }
  const mod = createModule({ now: () => Date.parse('2026-11-19T20:40:00+08:00') })
  const { api, sent } = makeApi(dataRoot, { settings: extra })
  let command = null
  api.command = spec => { command = spec }
  await mod.setup(api)
  assert.deepEqual([...command.aliases], ['摸鱼人日历'])
  extra.commands = '摸鱼人日历\n摸鱼办'
  assert.deepEqual([...command.aliases], ['摸鱼人日历', '摸鱼办'])
  const reply = await command.run('', { chatId: 'private:10000' })
  assert.equal(reply, '')
  assert.equal(sent.length, 1)
  assert.equal(sent[0].type, 'image')
})

test('不带斜杠的整句触发词会发图，别人说则不管', async () => {
  const dataRoot = mkdtempSync(join(tmpdir(), 'moyu-bare-'))
  await writeCache(dataRoot, '2026-11-19', PNG, 'image/png')
  const mod = createModule({ now: () => Date.parse('2026-11-19T20:50:00+08:00') })
  const { api, sent } = makeApi(dataRoot, { settings: { commands: '摸鱼人日历', caption: '' } })
  let onMessage = null
  api.on = (event, fn) => { if (event === 'message') onMessage = fn }
  api.isOwner = (userId) => userId === '10000'
  await mod.setup(api)
  const taken = await onMessage({ text: '摸鱼人日历', userId: '10000', chatId: 'private:10000' })
  assert.equal(taken, true)
  assert.equal(sent.filter(item => item.type === 'image').length, 1)
  const ignored = await onMessage({ text: '摸鱼人日历', userId: '10001', chatId: 'group:200' })
  assert.equal(ignored, false)
  assert.equal(sent.filter(item => item.type === 'image').length, 1)
})

test('图片发送返回 null 时不记为已发送，已入队则记下', async () => {
  const noneRoot = mkdtempSync(join(tmpdir(), 'moyu-null-'))
  await writeCache(noneRoot, '2026-11-19', PNG, 'image/png')
  let current = Date.parse('2026-11-19T07:00:00+08:00')
  const none = createModule({ now: () => current })
  const noneApi = makeApi(noneRoot, {
    settings: { caption: '附言' },
    sendSegments: async () => null,
  })
  const texts = []
  noneApi.api.sendText = async (_chatId, text) => { texts.push(text); return { message_id: 't' } }
  const noneRun = await none.setup(noneApi.api)
  current = Date.parse('2026-11-19T08:10:00+08:00')
  await noneRun.tick()
  assert.deepEqual(noneRun.status().state.sent, [])
  assert.match(noneRun.status().lastError, /没有发出去/)
  assert.equal(texts.length, 0)

  const queuedRoot = mkdtempSync(join(tmpdir(), 'moyu-queued-'))
  await writeCache(queuedRoot, '2026-11-19', PNG, 'image/png')
  current = Date.parse('2026-11-19T07:00:00+08:00')
  const queued = createModule({ now: () => current })
  const queuedApi = makeApi(queuedRoot, {
    settings: { caption: '附言' },
    sendSegments: async () => ({ queued: true, queuedId: 'q1' }),
  })
  const queuedTexts = []
  queuedApi.api.sendText = async () => { queuedTexts.push('x'); return { message_id: 't' } }
  const queuedRun = await queued.setup(queuedApi.api)
  current = Date.parse('2026-11-19T08:10:00+08:00')
  await queuedRun.tick()
  assert.deepEqual(queuedRun.status().state.sent, ['private:10001'])
  assert.equal(queuedRun.status().state.completed, '2026-11-19')
  assert.equal(queuedTexts.length, 0)
})

/** 面板调接口时的请求：默认是本机面板发出的同源 POST。 */
function panelRequest(body, headers = {}, method = 'POST') {
  const text = body == null ? '' : typeof body === 'string' ? body : JSON.stringify(body)
  const req = Readable.from(text ? [text] : [])
  req.method = method
  req.headers = { host: '127.0.0.1:5700', 'sec-fetch-site': 'same-origin', ...headers }
  return req
}

function albumOnlyFetch(state) {
  return async (url) => {
    const target = String(url)
    if (ALBUM_LIST.test(target)) {
      state.album += 1
      return htmlResponse(albumJson(state.today === false ? [TS - 86400] : [TS]), target)
    }
    if (target.startsWith('https://mp.weixin.qq.com/s?')) return htmlResponse(ARTICLE_HTML, target)
    if (target.includes('mmbiz.qpic.cn')) return bytesResponse(PNG, target)
    throw new Error(`不该请求 ${target}`)
  }
}

test('清除后的任务记录：今天的进度清零，别的日期不动', () => {
  const base = { date: '2026-11-19', attempts: 3, lastAttempt: 5, sent: ['group:200'], completed: '2026-11-19', noUpdate: '', firstSkip: '', fetched: '2026-11-19', title: 'x', source: 'album' }
  assert.deepEqual(clearedState(base, STAMP, 1), {
    date: '2026-11-19', attempts: 0, lastAttempt: 0, sent: [], completed: '', noUpdate: '', firstSkip: '', fetched: '', title: '', source: '',
  })
  // 昨天完成的、昨天取的图都留着。
  const old = { ...base, date: '2026-11-18', completed: '2026-11-18', fetched: '2026-11-18' }
  assert.deepEqual(clearedState(old, STAMP, 0), old)
  // 今天记成无更新的，清除后可以重新找。
  const none = { ...base, completed: '2026-11-18', noUpdate: '2026-11-19' }
  assert.equal(clearedState(none, STAMP, 0).noUpdate, '')
  assert.equal(clearedState(none, STAMP, 0).completed, '2026-11-18')
  // 空记录清完也只剩两个清掉的字段。
  assert.deepEqual(clearedState({}, STAMP, 0), { completed: '', noUpdate: '' })
  assert.equal(sourceLabel('album'), '合集')
  assert.equal(sourceLabel('rss'), 'RSS')
  assert.equal(sourceLabel('sogou'), '搜狗')
  assert.equal(sourceLabel('cache'), '缓存')
  assert.equal(sourceLabel(''), '未知')
})

test('写接口只认同源的 POST', async () => {
  const same = panelRequest({ confirm: true }, { origin: 'http://127.0.0.1:5700' })
  assert.equal(sameOriginRequest(same), true)
  assert.deepEqual(await readJsonBody(same), { confirm: true })
  assert.equal(sameOriginRequest(panelRequest({}, { 'sec-fetch-site': 'cross-site' })), false)
  assert.equal(sameOriginRequest(panelRequest({}, { origin: 'https://evil.example' })), false)
  assert.equal(sameOriginRequest(panelRequest({}, { origin: '不是地址' })), false)
  assert.equal(sameOriginRequest(panelRequest({}, { 'sec-fetch-site': 'same-origin', origin: 'http://127.0.0.1:5700' })), true)
  assert.equal(sameOriginRequest({}), false, '什么都不带的请求不算')
  assert.equal(sameOriginRequest(panelRequest(null, {}, 'GET')), false)
  assert.equal(sameOriginRequest(panelRequest(null, {}, 'HEAD')), false)
  assert.equal(sameOriginRequest({ method: 'POST', headers: {} }), true, '没带 Origin 和 Sec-Fetch-Site 的面板请求放行')
  assert.deepEqual(await readJsonBody(panelRequest(null)), {})
  await assert.rejects(readJsonBody(panelRequest('x'.repeat(5000))), /太大/)
  await assert.rejects(readJsonBody(panelRequest('{bad')), SyntaxError)
})

test('面板清除：删掉今天的缓存图，定时任务重新取图并再发一次', async () => {
  const dataRoot = mkdtempSync(join(tmpdir(), 'moyu-clear-'))
  await writeCache(dataRoot, '2026-11-19', PNG, 'image/png')
  await writeFile(join(dataRoot, '2026-11-18.png'), PNG)
  await writeFile(join(dataRoot, 'daily-state.json'), JSON.stringify({
    date: '2026-11-19', attempts: 1, lastAttempt: 1, sent: ['private:10001'], completed: '2026-11-19', noUpdate: '', firstSkip: '',
    fetched: '2026-11-19', title: 'old', source: 'album',
  }))
  let current = Date.parse('2026-11-19T07:00:00+08:00')
  const counter = { album: 0, today: true }
  const mod = createModule({ now: () => current, fetchImpl: albumOnlyFetch(counter), browserOf: () => { throw new Error('合集成功时不该用浏览器') } })
  const { api, routes, sent } = makeApi(dataRoot)
  const { tick, status } = await mod.setup(api)
  current = Date.parse('2026-11-19T09:00:00+08:00')
  await tick()
  assert.equal(counter.album, 0, '已经发过就不再取')

  const clear = routes['/clear']
  assert.ok(clear)
  assert.equal((await clear(panelRequest({ confirm: true }, {}, 'GET'))).ok, false)
  assert.equal((await clear(panelRequest({ confirm: true }, { 'sec-fetch-site': 'cross-site' }))).ok, false)
  assert.equal((await clear(panelRequest({ confirm: true }, { origin: 'https://evil.example' }))).ok, false)
  assert.equal((await clear(panelRequest({}))).ok, false, '没带 confirm 不算')
  assert.equal((await clear(panelRequest('not json'))).ok, false)
  assert.ok(await readCache(dataRoot, '2026-11-19'), '被拒绝的请求不能删图')

  const result = await clear(panelRequest({ confirm: true }))
  assert.equal(result.ok, true, result.message)
  assert.equal(result.removed, 1)
  assert.equal(await readCache(dataRoot, '2026-11-19'), null)
  assert.notEqual(await readCache(dataRoot, '2026-11-18'), null, '昨天的图不动')
  assert.deepEqual([status().state.completed, status().state.noUpdate, status().state.sent, status().fetched, status().source], ['', '', [], '', ''])
  assert.equal(status().today, 'pending')

  await tick()
  assert.equal(counter.album, 1)
  assert.deepEqual(sent.filter(item => item.type === 'image').map(item => item.chatId), ['private:10001'])
  assert.equal(status().state.completed, '2026-11-19')
  assert.equal(status().source, 'album')
  assert.equal((await readCache(dataRoot, '2026-11-19')) !== null, true)

  // 刚重新取到的图也会被清掉；没有缓存图时不报错。
  const again = await clear(panelRequest({ confirm: true }))
  assert.equal(again.ok, true, again.message)
  assert.equal(again.removed, 1)
  assert.equal(await readCache(dataRoot, '2026-11-19'), null)
  const nothing = await clear(panelRequest({ confirm: true }))
  assert.equal(nothing.removed, 0)
  assert.equal(await removeCache(dataRoot, '2026-11-18'), 1)
  assert.equal(await removeCache(dataRoot, '2026-11-18'), 0)
})

test('状态和日志里能看到实际来源；没重新取之前发的是缓存', async () => {
  const dataRoot = mkdtempSync(join(tmpdir(), 'moyu-source-'))
  const lines = []
  const counter = { album: 0, today: true }
  const mod = createModule({
    now: () => Date.parse('2026-11-19T09:00:00+08:00'),
    fetchImpl: albumOnlyFetch(counter),
    browserOf: () => { throw new Error('合集成功时不该用浏览器') },
  })
  const { api, routes, sent } = makeApi(dataRoot)
  api.log = { info: (...args) => lines.push(args), warn: (...args) => lines.push(args), error: (...args) => lines.push(args) }
  let command = null
  api.command = spec => { command = spec }
  const { status } = await mod.setup(api)
  const chat = { chatId: 'private:10000' }
  assert.match(await command.run('状态', chat), /实际来源：还没取过/)
  assert.match(await command.run('状态', chat), /取图顺序：合集 → 搜狗/)
  assert.equal(routes['/status']().fetched, '')

  await command.run('', chat)
  assert.equal(sent.filter(item => item.type === 'image').length, 1)
  assert.equal(counter.album, 1)
  assert.match(await command.run('状态', chat), /实际来源：合集，2026-11-19《/)
  const named = name => lines.filter(line => line[0] === name).map(line => line.join(' '))
  assert.match(named('摸鱼日历取到图')[0], /来源：合集/)
  assert.match(named('摸鱼日历手动取图')[0], /来源：合集/)

  // 第二次发的是缓存，不再请求合集。
  await command.run('', chat)
  assert.equal(counter.album, 1)
  assert.equal(sent.filter(item => item.type === 'image').length, 2)
  assert.match(named('摸鱼日历手动取图')[1], /缓存/)
  assert.match(named('摸鱼日历手动取图')[1], /合集/)

  // 取不到时也留一条日志，写明每一路的结果。
  const failedRoot = mkdtempSync(join(tmpdir(), 'moyu-fail-'))
  const failLines = []
  const failed = createModule({ now: () => Date.parse('2026-11-19T09:00:00+08:00'), fetchImpl: albumOnlyFetch({ album: 0, today: false }) })
  const failedApi = makeApi(failedRoot)
  failedApi.api.log = { info() {}, warn: (...args) => failLines.push(args), error() {} }
  failedApi.api.use = () => null
  let failedCommand = null
  failedApi.api.command = spec => { failedCommand = spec }
  await failed.setup(failedApi.api)
  const reply = await failedCommand.run('', chat)
  assert.match(reply, /合集里还没有/)
  assert.equal(failLines.length, 1)
  assert.equal(failLines[0][0], '摸鱼日历手动获取没取到')
  assert.match(failLines[0][1], /合集里还没有/)
  // 没取到时也带上每一试过的来源。
  assert.match(failLines[0][2], /^合集：没有今天的文章 → 搜狗：搜狗请求失败/)
})

test('日志写明每一试过的来源：RSS 是空的，所以用了合集', async () => {
  const LAN = 'http://192.168.1.8/moyu'
  const emptyFeed = '<?xml version="1.0"?><rss version="2.0"><channel><title>摸鱼人日历</title></channel></rss>'
  const fetchImpl = async (url) => {
    const target = String(url)
    if (target === LAN) return htmlResponse(emptyFeed, target)
    if (ALBUM_LIST.test(target)) return htmlResponse(albumJson(), target)
    if (target.startsWith('https://mp.weixin.qq.com/s?')) return htmlResponse(ARTICLE_HTML, target)
    if (target.includes('mmbiz.qpic.cn')) return bytesResponse(PNG, target)
    throw new Error(`不该请求 ${target}`)
  }
  const withRss = await resolveCalendar({ stamp: STAMP, rssUrl: LAN, rssAllowPrivate: true, fetchImpl })
  assert.equal(withRss.ok, true, withRss.error)
  assert.deepEqual(withRss.trace.map(step => [step.source, step.ok, step.missing]), [['rss', false, true], ['album', true, false]])
  assert.equal(traceText(withRss.trace), 'RSS：没有今天的文章 → 合集：成功')

  // 没配 RSS 就不记这一步。
  const noRss = await resolveCalendar({ stamp: STAMP, fetchImpl })
  assert.deepEqual(noRss.trace.map(step => step.source), ['album'])

  // 全失败时三路都在，长错误截短。
  const all = await resolveCalendar({
    stamp: STAMP,
    rssUrl: LAN,
    rssAllowPrivate: true,
    fetchImpl: async url => htmlResponse('<html><body>没有结果</body></html>', String(url)),
  })
  assert.equal(all.ok, false)
  // 前两路是自己出的错，所以搜狗的「没有收录」不算数，记成它的原话。
  assert.match(traceText(all.trace), /^RSS：RSS 不像 RSS\/Atom → 合集：合集返回的不是 JSON → 搜狗：搜狗还没有今天的摸鱼人日历$/)
  // 返回里不留内部用的字段。
  assert.equal('stepError' in all, false)
  assert.equal('stepError' in all.trace[2], false)
  assert.equal(traceText([{ source: 'sogou', ok: false, missing: false, error: 'x'.repeat(80) }]), `搜狗：${'x'.repeat(40)}`)
  assert.equal(traceText([{ source: 'album', ok: false, missing: false, error: '' }]), '合集：失败')
  assert.equal(traceText([]), '')

  // 模块写出来的日志里也带着这一行。
  const dataRoot = mkdtempSync(join(tmpdir(), 'moyu-trace-'))
  const lines = []
  const mod = createModule({ now: () => Date.parse('2026-11-19T09:00:00+08:00'), fetchImpl })
  const { api, sent } = makeApi(dataRoot, { settings: { rssUrl: LAN, rssAllowPrivate: true } })
  api.log = { info: (...args) => lines.push(args), warn: (...args) => lines.push(args), error() {} }
  let command = null
  api.command = spec => { command = spec }
  const { status } = await mod.setup(api)
  await command.run('', { chatId: 'private:10000' })
  assert.equal(sent.filter(item => item.type === 'image').length, 1)
  assert.equal(status().source, 'album')
  const line = lines.find(args => args[0] === '摸鱼日历取到图')
  assert.equal(line[1], '来源：合集')
  assert.equal(line[2], 'RSS：没有今天的文章 → 合集：成功')
})
