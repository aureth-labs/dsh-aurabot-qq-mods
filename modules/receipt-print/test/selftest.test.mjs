import test from 'node:test'
import assert from 'node:assert/strict'
import { buildSelfTestPage, buildSelfTestQr, rulerLine, tickLine, boxLines, testPattern } from '../lib/selftest.mjs'
import { qrCapacityForDots, qrModuleSize } from '../lib/qr.mjs'
import { displayWidth, wrapText } from '../lib/layout.mjs'

const page = () => buildSelfTestPage({
  printer: { name: 'DL', transport: 'windows', target: 'DL', encoding: 'gbk', cut: 'partial' },
  paper: { columns: 32, paperMm: 58, effectiveMm: 48, dots: 384 },
  settings: { encoding: 'gbk', cut: 'partial', imageDither: true },
  transportLabel: 'Windows 打印队列',
  version: '0.12.0',
  now: new Date(2026, 10, 27, 10, 30, 0),
})

test('自检页：每行都不超纸宽，倍宽标题按半宽算', () => {
  const built = page()
  for (const line of built.lines) {
    const width = displayWidth(line.text)
    if (line.style === 'title') assert.ok(width * 2 <= built.columns, `标题超宽：${line.text}`)
    else assert.ok(width <= built.columns, `行超宽（${width}/${built.columns}）：${line.text}`)
  }
})

test('自检页：设备信息带打印机名、版本和时间', () => {
  const text = page().lines.map((l) => l.text).join('\n')
  assert.match(text, /打印机：DL/)
  assert.match(text, /Windows 打印队列/)
  assert.match(text, /纸宽：58mm · 有效 48mm · 32 列/)
  assert.match(text, /插件：0\.12\.0/)
  assert.match(text, /2026-11-27 10:30 星期五/)
  assert.match(text, /伽马 1\.3/)
  assert.match(text, /消息打印：只主人/)
  assert.match(text, /二维码：自动/)
})

test('自检页：对齐、字号、字符、刻度都在，且有居中/右对齐样式', () => {
  const built = page()
  const styles = new Set(built.lines.map((l) => l.style))
  for (const style of ['title', 'center', 'right', 'bold', 'big', 'large', 'wide', 'underline', 'invert', 'barcode', 'sep']) {
    assert.ok(styles.has(style), `缺少样式 ${style}`)
  }
  const text = built.lines.map((l) => l.text).join('\n')
  assert.match(text, /中文：热敏打印中文正常/)
  assert.match(text, /打印头测试图/)
  assert.ok(built.lines.some((l) => l.text === rulerLine(built.columns)))
})

test('自检页：新增的版式、字符、金额、线条、表格、条码段都在', () => {
  const built = page()
  const text = built.lines.map((l) => l.text).join('\n')
  for (const title of ['字号与效果', '缩进与版式', '字符测试', '数字与金额', '线条样式', '表格示例', '条码测试', '走纸与切纸']) {
    assert.match(text, new RegExp(title))
  }
  assert.match(text, /ASCII 32-63:/)
  assert.match(text, /abcdefghijklmnopqrstuvwxyz/)
  assert.match(text, /生僻字/)
  assert.match(text, /简体|繁體|繁体/)
  assert.match(text, /日文/)
  assert.match(text, /合计 3\.50/)
  assert.ok(built.lines.some((l) => l.style === 'barcode' && l.text === 'AURABOT-2026'))
  assert.ok(built.lines.some((l) => l.text === '-'.repeat(built.columns)), '应该有满行虚线')
})

test('自检页：打印头测试图插在说明和走纸之间，不再堆到最末尾', () => {
  const built = page()
  const imageIndex = built.lines.findIndex((l) => l.style === 'image')
  const noteIndex = built.lines.findIndex((l) => /打印头测试图/.test(l.text))
  const feedIndex = built.lines.findIndex((l) => /走纸与切纸/.test(l.text))
  assert.ok(imageIndex > noteIndex, '图片要在说明之后')
  assert.ok(imageIndex < feedIndex, '图片要在走纸说明之前')
  assert.equal(built.lines[imageIndex].image.width, built.dots)
  assert.deepEqual(built.images, [], '不再走末尾统一追加的图片数组')
})

test('刻度行正好铺满 columns 列', () => {
  for (const columns of [32, 48, 24]) {
    assert.equal(rulerLine(columns).length, columns)
    assert.equal(tickLine(columns).length, columns)
    assert.equal(displayWidth(tickLine(columns)), columns)
  }
})

test('方框每行都是 columns 宽', () => {
  const box = boxLines(32, 'BOARD')
  assert.equal(box.length, 3)
  for (const line of box) assert.equal(displayWidth(line), 32, line)
  assert.match(box[1], /BOARD/)
})

test('打印头测试图：宽度等于点数，四周有黑点', () => {
  const image = testPattern(384)
  assert.equal(image.width, 384)
  assert.ok(image.height >= 24)
  assert.equal(image.data.length, Math.ceil(384 / 8) * image.height)
  const bitAt = (x, y) => (image.data[y * Math.ceil(384 / 8) + (x >> 3)] & (0x80 >> (x & 7))) !== 0
  assert.ok(bitAt(0, 0), '左边框应该是黑的')
  assert.ok(bitAt(383, image.height - 1), '右边框应该是黑的')
  assert.ok(bitAt(2, 1), '顶部竖条应该有点')
})

test('自检页文字折行后不溢出：长句按 columns 断行', () => {
  const long = '中文中文中文中文中文中文中文中文中文中文中文中文'
  for (const line of wrapText(long, 32)) assert.ok(displayWidth(line) <= 32)
})

test('自检页：对齐两段都在，空格填充正好 columns 宽', () => {
  const built = buildSelfTestPage({
    printer: { name: 'DL', transport: 'windows', target: 'DL' },
    paper: { columns: 32, paperMm: 58, effectiveMm: 48, dots: 384 },
    settings: {},
    transportLabel: 'Windows 打印队列',
    version: '0.13.0',
  })
  const text = built.lines.map((l) => l.text).join('\n')
  assert.match(text, /对齐测试（对齐指令）/)
  assert.match(text, /对齐测试（空格填充）/)
  const centered = built.lines.find((l) => l.text.trim() === 'CENTER' && l.style === 'normal')
  assert.ok(centered, '应该有空格居中的 CENTER')
  assert.equal(displayWidth(centered.text), built.columns)
  const righted = built.lines.find((l) => l.text.trim() === 'RIGHT' && l.style === 'normal')
  assert.equal(displayWidth(righted.text), built.columns)
})

test('自检页：详细系统/驱动信息分行，长路径不超宽', () => {
  const built = buildSelfTestPage({
    printer: { name: 'DL', transport: 'windows', target: 'DL' },
    paper: { columns: 32, paperMm: 58, effectiveMm: 48, dots: 384 },
    settings: {},
    version: '0.13.0',
    extraInfo: [
      { title: '系统信息', rows: [['用户名', 'Administrator'], ['计算机名', 'DESKTOP-ABC']] },
      { title: '驱动程序', rows: [['配置文件', 'C:\\Windows\\System32\\spool\\drivers\\x64\\3\\dl58.dll']] },
    ],
  })
  const text = built.lines.map((l) => l.text)
  assert.ok(text.includes('用户名：Administrator'))
  assert.ok(text.includes('计算机名：DESKTOP-ABC'))
  assert.ok(!text.some((line) => line.includes('C:\\Windows\\System32\\spool\\drivers\\x64\\3\\dl58.dll')), '长路径要折行')
  for (const line of built.lines) assert.ok(displayWidth(line.text) <= built.columns, line.text)
})

test('自检二维码：包含设备、系统、打印机、驱动、端口和时间', () => {
  const qr = buildSelfTestQr({
    printer: { name: 'DL', transport: 'windows', target: 'DL', encoding: 'gbk', cut: 'partial' },
    paper: { columns: 32, paperMm: 58, effectiveMm: 48, dots: 384 },
    settings: { encoding: 'gbk', cut: 'partial', imageDither: true },
    transportLabel: 'Windows 打印队列',
    version: '0.15.0',
    now: new Date(2026, 10, 27, 10, 30, 0),
    extraInfo: [
      { title: '系统信息', rows: [['用户名', 'Administrator'], ['计算机名', 'DESKTOP-ABC']] },
      { title: '打印机信息', rows: [['打印机型号', 'DL-58'], ['端口名称', 'USB001']] },
      { title: '驱动程序', rows: [['驱动版本', '1.2.3']] },
    ],
  })
  for (const part of ['AURABOT', '自检', '打印机：DL', '通道：USB', '纸张：58/48mm', '32列', 'v0.15.0', '2026-11-27 10:30', '用户名：Administrator', '计算机名：DESKTOP-ABC', '打印机型号：DL-58', '端口名称：USB001', '驱动版本：1.2.3']) {
    assert.ok(qr.includes(part), `二维码缺少 ${part}`)
  }
  const bytes = Buffer.byteLength(qr, 'utf8')
  assert.ok(bytes <= qrCapacityForDots(384, 4), '二维码内容不能超过 4 点模块的容量')
  assert.ok(qrModuleSize({ bytes, dots: 384 }) >= 4, '58mm 纸上的自检二维码至少 4 点模块')
})

test('自检二维码：长驱动路径只留文件名，扫得清也扫得全', () => {
  const qr = buildSelfTestQr({
    printer: { name: 'DL', transport: 'windows', target: 'DL' },
    paper: { columns: 32, paperMm: 58, effectiveMm: 48, dots: 384 },
    version: '0.19.0',
    extraInfo: [{ title: '驱动程序', rows: [['INF 文件', 'C:\\Windows\\INF\\oem12.inf']] }],
  })
  assert.ok(qr.includes('INF 文件：…/oem12.inf'), qr)
  assert.ok(!qr.includes('C:\\Windows\\INF'), '长路径不该整段塞进二维码')
})

test('自检二维码：内容超长时截断并加省略号，不超纸宽容量', () => {
  const longRows = Array.from({ length: 80 }, (_, i) => [`文件${i}`, `C:\\Windows\\System32\\spool\\drivers\\x64\\3\\driver-${i}.dll`])
  const qr = buildSelfTestQr({
    printer: { name: 'DL', transport: 'windows', target: 'DL' },
    paper: { columns: 32, paperMm: 58, effectiveMm: 48, dots: 384 },
    version: '0.15.0',
    extraInfo: [{ title: '驱动程序', rows: longRows }],
  })
  assert.ok(Buffer.byteLength(qr, 'utf8') <= qrCapacityForDots(384, 4))
  assert.ok(qr.endsWith('…'))
  assert.ok(!qr.includes('\uFFFD'))
})
