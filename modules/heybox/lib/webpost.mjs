// 浏览器兜底发帖。
//
// 为什么需要：2026-11 起 `/bbs/app/api/link/post` 对同一账号开始返回
// `status=failed「发布功能暂不可用」`，而同一个登录取网页创作者编辑器能正常发
// （已在真实账号上验过：带图发帖成功、能拿到 link id、也能删掉）。看起来是服务端
// 把 App 侧的旧发帖接口关掉了，改接口签名不是我们能决定的。
//
// 所以：API 发帖被服务端以「发布功能暂不可用」这类软拒挡掉时，改走网页编辑器 ——
// 用同一份 Cookie 灌进浏览器，把标题/正文/图填进 ProseMirror，选社区，点发布，
// 再从跳转地址里取帖子 id。
//
// 关键实现约束（都是实测出来的，别随手改）：
//   · 标题和正文都是 ProseMirror，设 value 没用，必须 focus 后走 insertHTML；
//   · 图片节点用模块上传后拿到的 COS 地址，形状必须是
//     `<img data-type="image" data-original=URL data-width data-height>`，
//     ProseMirror 认它、服务端也认（实测带图发帖成功）；
//   · 社区必须先选，否则发布按钮点了没反应；
//   · 发布成功后页面会跳到 /app/bbs/link/<id>，id 从这里取。

const HOME = 'https://www.xiaoheihe.cn/app/bbs/home'
const EDITOR = 'https://www.xiaoheihe.cn/creator/editor/draft/image_text/'
const TITLE_SEL = '.editor-title__container .ProseMirror.hb-editor'
const BODY_SEL = '.image-text__edit-content--inner .ProseMirror.hb-editor'
const WAIT = (ms) => new Promise((r) => setTimeout(r, ms))

// 这些是「接口本身还在，只是不让我们用」的信号 → 值得改走浏览器。
// 别的失败（字数 / 配图 / 分区 / 网络）走浏览器也一样白跑，不该兜底。
export const WEB_FALLBACK_HINTS = ['发布功能暂不可用', '功能暂不可用', '暂无发布权限', '不允许发布']

export function shouldFallbackToWeb(result) {
  if (!result || result.ok) return false
  if (result.code === 'too_short' || result.code === 'too_long') return false
  if (result.code === 'bad_topic' || result.code === 'image_upload_failed' || result.code === 'input') return false
  const msg = String(result.message || '')
  return WEB_FALLBACK_HINTS.some((h) => msg.includes(h))
}

/** buildArticle 的 blocks → 编辑器要的 HTML（文字段落 + 图片节点按原顺序穿插） */
export function blocksToEditorHtml(blocks) {
  const out = []
  for (const b of Array.isArray(blocks) ? blocks : []) {
    if (!b) continue
    if (b.type === 'html' && b.text) out.push(String(b.text))
    else if (b.type === 'img' && b.url) {
      const w = Number(b.width) || 1080
      const h = Number(b.height) || 780
      out.push(`<p><img data-type="image" data-original="${b.url}" data-width="${w}" data-height="${h}" data-description=""></p>`)
    }
  }
  return out.join('')
}

/**
 * 把一帖发到网页编辑器。
 * @param browser  createBrowser() 的实例（要已 open）
 * @param cookie   模块当前使用的 Cookie 文本
 * @param title    标题
 * @param blocks   buildArticle 返回的 blocks
 * @param communityName 社区名（默认「盒友杂谈」）
 */
export async function postViaWeb({ browser, cookie, title, blocks, communityName = '盒友杂谈', log, signal } = {}) {
  if (!browser) return { ok: false, message: '浏览器没准备好' }
  const check = () => { if (signal?.aborted) throw new Error('已取消') }
  const t = String(title || '').trim()
  const html = blocksToEditorHtml(blocks)
  if (!t) return { ok: false, message: '没有标题' }
  if (!html) return { ok: false, message: '没有正文' }

  // 1) 登录态：把模块的 Cookie 灌进浏览器（比让主人重新扫码省事）
  const cookieList = parseCookie(cookie)
  if (cookieList.length) {
    try { await browser.setCookies(cookieList) } catch (e) { log?.warn?.('网页兜底：灌 Cookie 失败（' + e.message + '），用浏览器自己的登录态') }
  }
  const loggedIn = await browser.evaluate(`(() => { try { return !!localStorage.getItem('user') || !!document.cookie.includes('pkey') } catch { return false } })()`).catch(() => false)

  // 2) 进编辑器（直接开草稿页比点首页按钮稳：首页那个入口是懒加载的）
  const draftId = 'local_' + Date.now().toString(36)
  await browser.goto(EDITOR + draftId + '?draft_session_id=' + draftId)
  check()
  if (!(await browser.waitFor(BODY_SEL))) return { ok: false, message: '创作者编辑器没打开（可能没登录）', needLogin: !loggedIn }

  // 3) 填标题 + 正文（一次 insertHTML，保证段落与图片顺序不乱）
  const filled = await browser.evaluate(`(() => {
    const te = document.querySelector(${JSON.stringify(TITLE_SEL)})
    const be = document.querySelector(${JSON.stringify(BODY_SEL)})
    if (!te || !be) return { ok: false }
    te.innerHTML = ''; be.innerHTML = ''
    te.focus()
    document.execCommand('insertHTML', false, ${JSON.stringify('<p>' + escapeHtml(t) + '</p>')})
    be.focus()
    const done = document.execCommand('insertHTML', false, ${JSON.stringify(html)})
    return { ok: true, done, title: (te.innerText || '').trim(), imgs: be.querySelectorAll('img').length, paras: be.querySelectorAll('p').length, text: (be.innerText || '').trim().slice(0, 60) }
  })()`)
  check()
  if (!filled?.ok) return { ok: false, message: '编辑器的标题/正文输入框没找到' }
  if (!filled.title || !filled.paras) return { ok: false, message: '编辑器没接受标题或正文（页面结构可能变了）' }
  log?.info?.(`网页兜底：已填入「${filled.title}」，${filled.paras} 段 / ${filled.imgs} 张图`)

  // 4) 选社区（不选的话发布按钮点了没反应）
  const communityOk = await pickCommunity(browser, communityName, log)
  check()

  // 5) 点发布，等跳转
  const clicked = await browser.evaluate(`(() => {
    const b = [...document.querySelectorAll('button.editor-publish__btn.main-btn')].find((n) => /发布/.test(n.innerText || ''))
    if (!b) return false
    b.click(); return true
  })()`)
  if (!clicked) return { ok: false, message: '没找到发布按钮' }
  check()

  let id = ''
  for (let i = 0; i < 40; i++) {
    await WAIT(500)
    check()
    const href = await browser.evaluate('location.href').catch(() => '')
    const m = String(href).match(/\/app\/bbs\/link\/(\d+)/)
    if (m) { id = m[1]; break }
    // 有的情况停在草稿页但弹了错，抓一句提示出来
    if (i === 20) {
      const tip = await browser.evaluate(`(() => [...document.querySelectorAll('[class*=toast],[class*=message],[class*=dialog],[class*=error]')].map((n) => (n.innerText || '').trim()).filter(Boolean)[0] || '')`).catch(() => '')
      if (tip) log?.warn?.('网页兜底：页面上有提示「' + String(tip).slice(0, 60) + '」')
    }
  }
  if (!id) return { ok: false, message: '点了发布但没跳到帖子页（可能被审核或校验挡住）', communityOk }

  return {
    ok: true,
    linkId: id,
    url: `https://www.xiaoheihe.cn/app/bbs/link/${id}`,
    communityOk,
    imgs: filled.imgs,
    paras: filled.paras,
    message: `网页兜底发出去了：https://www.xiaoheihe.cn/app/bbs/link/${id}`,
  }
}

async function pickCommunity(browser, name, log) {
  try {
    const opened = await browser.evaluate(`(() => {
      const b = [...document.querySelectorAll('button.editor__add-btn')].find((n) => /添加社区/.test(n.innerText || ''))
      if (!b) return false
      b.click(); return true
    })()`)
    if (!opened) { log?.warn?.('网页兜底：没找到「添加社区」按钮'); return false }
    // 弹窗（.editor__model-frame）是懒渲染的，列表要等出来再点
    if (!(await browser.waitFor('.editor__model-frame'))) { log?.warn?.('网页兜底：选社区的弹窗没出来'); return false }
    await WAIT(1200)

    // ⚠ 列表项文本长这样：「盒友杂谈\n热度:71544865」—— 用精确等于 innerText 是匹配不上的
    // （早期版本就是这么写的，结果每次都没选上社区、帖子发进无分区）。这里按「首行等于社区名」认。
    const picked = await browser.evaluate(`(() => {
      const want = ${JSON.stringify(String(name))}
      const frame = [...document.querySelectorAll('.editor__model-frame')].find((n) => n.offsetParent)
      if (!frame) return { ok: false, why: 'no-frame' }
      const items = [...frame.querySelectorAll('li, [class*=item], [class*=card], [class*=community]')]
        .filter((n) => n.offsetParent && (n.innerText || '').trim())
      const head = (n) => (n.innerText || '').trim().split('\\n')[0].trim()
      const hit = items.find((n) => head(n) === want) || items.find((n) => head(n).includes(want))
      if (!hit) return { ok: false, why: 'not-listed', sample: items.slice(0, 6).map(head) }
      hit.click()
      return { ok: true, text: head(hit) }
    })()`)
    if (!picked?.ok) {
      // 列表里没有目标社区时，退一步用弹窗里的搜索框
      const searched = await browser.evaluate(`(() => {
        const inp = [...document.querySelectorAll('.editor__model-frame input')].find((n) => n.offsetParent)
        if (!inp) return false
        inp.focus(); inp.value = ${JSON.stringify(String(name))}
        inp.dispatchEvent(new Event('input', { bubbles: true }))
        return true
      })()`)
      if (searched) {
        await WAIT(1500)
        const again = await browser.evaluate(`(() => {
          const want = ${JSON.stringify(String(name))}
          const frame = [...document.querySelectorAll('.editor__model-frame')].find((n) => n.offsetParent)
          if (!frame) return false
          const head = (n) => (n.innerText || '').trim().split('\\n')[0].trim()
          const hit = [...frame.querySelectorAll('li, [class*=item], [class*=card], [class*=community]')]
            .filter((n) => n.offsetParent && (n.innerText || '').trim())
            .find((n) => head(n) === want || head(n).includes(want))
          if (!hit) return false
          hit.click(); return true
        })()`)
        if (!again) { log?.warn?.('网页兜底：搜索后仍没选上社区「' + name + '」'); return false }
      } else {
        log?.warn?.('网页兜底：社区「' + name + '」不在列表里' + (picked?.sample ? '（看到的有：' + picked.sample.join(' / ') + '）' : ''))
        return false
      }
    }
    await WAIT(1500)
    // 复查：面板上的「关联社区」计数应该从 0/2 变成 1/2
    const count = await browser.evaluate(`(() => {
      const t = [...document.querySelectorAll('.editor__more-info--left')].find((n) => /关联社区/.test(n.innerText || ''))
      const m = t && (t.innerText || '').match(/(\\d+)\\s*\\/\\s*\\d+/)
      return m ? Number(m[1]) : -1
    })()`).catch(() => -1)
    if (count === 0) { log?.warn?.('网页兜底：点了社区但面板计数还是 0，可能没生效'); return false }
    log?.info?.('网页兜底：社区已选上' + (count > 0 ? '（' + count + '/2）' : ''))
    return true
  } catch (e) {
    log?.warn?.('网页兜底：选社区出错（' + e.message + '）')
    return false
  }
}

/** 把 "a=1; b=2" 解析成 CDP 要的 [{name,value}] */
export function parseCookie(text) {
  return String(text || '').split(';').map((kv) => {
    const i = kv.indexOf('=')
    if (i <= 0) return null
    return { name: kv.slice(0, i).trim(), value: kv.slice(i + 1).trim() }
  }).filter((x) => x && x.name)
}

function escapeHtml(s) {
  return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
}
