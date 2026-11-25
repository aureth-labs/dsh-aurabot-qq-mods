import test from 'node:test'
import assert from 'node:assert/strict'
import { substitute, formatDate, buildPrompt, cleanModelText, buildLines, previewText } from '../lib/templates.mjs'

test('占位符替换：未知占位符原样保留', () => {
  assert.equal(substitute('今天是 {date} {weekday} {unknown}', { date: '2026-11-20', weekday: '星期五' }), '今天是 2026-11-20 星期五 {unknown}')
})

test('日期格式化', () => {
  const d = formatDate(new Date(2026, 10, 20, 8, 5))
  assert.deepEqual(d, {
    date: '2026-11-20', time: '08:05', weekday: '星期五', weekdayNum: 5, datetime: '2026-11-20 08:05',
  })
})

test('构造提示词：正文和系统提示词都替换', () => {
  const { system, text } = buildPrompt(
    { name: '简报', prompt: '{date} 的简报，纸宽 {width}', system: '不超过 {width} 字' },
    { width: 32, now: new Date(2026, 10, 20, 8, 5) },
  )
  assert.equal(text, '2026-11-20 的简报，纸宽 32')
  assert.equal(system, '不超过 32 字')
})

test('模型输出清洗：去掉 Markdown', () => {
  const out = cleanModelText('```text\n# 标题\n- 第一条\n**重点** 和 `代码`\n[链接](https://x.com)\n```')
  assert.equal(out, '标题\n· 第一条\n重点 和 代码\n链接')
})

test('模型输出清洗：超长截断', () => {
  const out = cleanModelText('啊'.repeat(100), { maxChars: 20 })
  assert.equal(out.length, 21)
  assert.ok(out.endsWith('…'))
})

test('组装打印行：页眉、正文、页脚、分隔线', () => {
  const { lines, qr } = buildLines({
    template: { name: '每日简报' },
    body: '第一行\n第二行',
    width: 20,
    showHeader: true,
    footer: '来自 Aurabot',
    qr: 'https://example.com',
    now: new Date(2026, 10, 20, 8, 5),
  })
  assert.equal(lines[0].style, 'title')
  assert.equal(lines[0].text, '每日简报')
  assert.ok(lines.some((l) => l.text.includes('2026-11-20 08:05')))
  assert.ok(lines.some((l) => l.style === 'sep'))
  assert.ok(lines.some((l) => l.text === '来自 Aurabot'))
  assert.equal(qr, 'https://example.com')

  const text = previewText(lines)
  assert.ok(text.includes('第一行'))
  assert.ok(text.includes('第二行'))
})

test('组装打印行：打开彩蛋会追加幸运数字和小图案', () => {
  const { lines } = buildLines({
    template: { name: '今日总结' },
    body: '今天还不错',
    width: 32,
    now: new Date(2026, 10, 20, 18, 0),
    fun: true,
  })
  assert.ok(lines.some((l) => l.text.includes('幸运数字')))
  assert.ok(lines.some((l) => l.text.includes('今日关键词')))
  assert.ok(lines.some((l) => /^[\s\\/()|._'"`*<>^o-]+$/.test(l.text) && l.text.trim()), '应包含一个 ASCII 小图案')

  const plain = buildLines({ template: { name: '今日总结' }, body: 'x', width: 32, fun: false })
  assert.equal(plain.lines.some((l) => l.text.includes('幸运数字')), false)
})

test('组装打印行：标题按半宽折行，正文按整宽折行', () => {
  const { lines } = buildLines({ template: { name: '一二三四五六七八九十' }, body: '一二三四五六七八九十', width: 10, showHeader: true })
  const titleLines = lines.filter((l) => l.style === 'title')
  for (const line of titleLines) assert.ok(line.text.length <= 5)
  const bodyLine = lines.find((l) => l.text === '一二三四五')
  assert.ok(bodyLine)
})
