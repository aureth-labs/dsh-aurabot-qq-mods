// test/tutk-lib.test.mjs —— BambuSource 自动下载：代理顺序、zip/tar 解压、失败降级。
import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm, stat } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { deflateRawSync, gunzipSync, gzipSync } from 'node:zlib'
import {
  downloadBambuSource, isCnLikely, orderUrls, parseTarEntries, parseZipCentralDirectory,
  resolveDestDir, targetFor, expectedLibSha256, KNOWN_LIB_SHA256,
  GH_PROXIES, KNOWN_RELEASE, MAX_ASSET_BYTES, OBN_RELEASES,
} from '../lib/tutk-lib.mjs'

const DLL = Buffer.concat([Buffer.from('MZ'), Buffer.alloc(80 * 1024, 7)])

/* ---------- 造一个最小可用的 zip（store 或 deflate） ---------- */
function makeZip (entries) {
  const locals = []
  const central = []
  let offset = 0
  for (const e of entries) {
    const name = Buffer.from(e.name, 'utf8')
    const raw = Buffer.isBuffer(e.data) ? e.data : Buffer.from(String(e.data))
    const comp = e.store ? raw : deflateRawSync(raw)
    const method = e.store ? 0 : 8
    const crc = crc32(raw)
    const local = Buffer.alloc(30)
    local.writeUInt32LE(0x04034b50, 0)
    local.writeUInt16LE(20, 4)
    local.writeUInt16LE(0, 6)
    local.writeUInt16LE(method, 8)
    local.writeUInt32LE(crc, 14)
    local.writeUInt32LE(comp.length, 18)
    local.writeUInt32LE(raw.length, 22)
    local.writeUInt16LE(name.length, 26)
    locals.push(local, name, comp)
    const cd = Buffer.alloc(46)
    cd.writeUInt32LE(0x02014b50, 0)
    cd.writeUInt16LE(20, 4)
    cd.writeUInt16LE(20, 6)
    cd.writeUInt16LE(0, 8)
    cd.writeUInt16LE(method, 10)
    cd.writeUInt32LE(crc, 16)
    cd.writeUInt32LE(comp.length, 20)
    cd.writeUInt32LE(raw.length, 24)
    cd.writeUInt16LE(name.length, 28)
    cd.writeUInt32LE(offset, 42)
    central.push(cd, name)
    offset += 30 + name.length + comp.length
  }
  const cdBuf = Buffer.concat(central)
  const eocd = Buffer.alloc(22)
  eocd.writeUInt32LE(0x06054b50, 0)
  eocd.writeUInt16LE(entries.length, 8)
  eocd.writeUInt16LE(entries.length, 10)
  eocd.writeUInt32LE(cdBuf.length, 12)
  eocd.writeUInt32LE(offset, 16)
  return Buffer.concat([...locals, cdBuf, eocd])
}

function crc32 (buf) {
  let c = ~0
  for (let i = 0; i < buf.length; i++) {
    c ^= buf[i]
    for (let k = 0; k < 8; k++) c = (c >>> 1) ^ (0xEDB88320 & -(c & 1))
  }
  return (~c) >>> 0
}

/* ---------- 造一个最小可用的 tar.gz ---------- */
function makeTarGz (entries) {
  const blocks = []
  for (const e of entries) {
    const data = Buffer.isBuffer(e.data) ? e.data : Buffer.from(String(e.data))
    const header = Buffer.alloc(512)
    header.write(e.name, 0, 100, 'utf8')
    header.write('000644 \0', 100, 8, 'utf8')
    header.write('000000 \0', 108, 8, 'utf8')
    header.write('000000 \0', 116, 8, 'utf8')
    header.write(data.length.toString(8).padStart(11, '0') + '\0', 124, 12, 'utf8')
    header.write('00000000000\0', 136, 12, 'utf8')
    header.write('        ', 148, 8, 'utf8')
    header.write('0', 156, 1, 'utf8')
    let sum = 0
    for (let i = 0; i < 512; i++) sum += header[i]
    header.write(sum.toString(8).padStart(6, '0') + '\0 ', 148, 8, 'utf8')
    blocks.push(header, data)
    const pad = (512 - (data.length % 512)) % 512
    if (pad) blocks.push(Buffer.alloc(pad))
  }
  blocks.push(Buffer.alloc(1024))
  return gzipSync(Buffer.concat(blocks))
}

/** 假 fetch：按 URL 前缀返回不同东西，可注入失败。 */
function fakeFetch (routes) {
  const calls = []
  return {
    calls,
    impl: async (url, init) => {
      calls.push({ url, init })
      for (const r of routes) {
        if (url.startsWith(r.match)) {
          if (r.fail) throw new Error(r.fail)
          const body = typeof r.body === 'function' ? await r.body(url, init) : r.body
          const buf = Buffer.isBuffer(body) ? body : Buffer.from(String(body))
          const range = String(init?.headers?.Range || '')
          if (range && r.range) {
            const m = /bytes=(\d+)-(\d+)/.exec(range)
            const start = Number(m[1])
            const end = Math.min(Number(m[2]), buf.length - 1)
            const slice = buf.subarray(start, end + 1)
            return {
              status: 206,
              headers: new Headers({ 'content-range': 'bytes ' + start + '-' + end + '/' + buf.length }),
              arrayBuffer: async () => slice.buffer.slice(slice.byteOffset, slice.byteOffset + slice.length),
              text: async () => slice.toString('utf8'),
              body: null,
            }
          }
          if (Array.isArray(r.seq)) {
            const step = r.seq.shift() || r.seq[r.seq.length - 1]
            if (step === 'fail') throw new Error('boom')
          }
          return {
            status: 200,
            headers: new Headers({ 'content-length': String(buf.length) }),
            arrayBuffer: async () => buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.length),
            text: async () => buf.toString('utf8'),
            body: null,
          }
        }
      }
      throw new Error('unexpected url ' + url)
    },
  }
}

const RELEASE_JSON = JSON.stringify({
  tag_name: 'v9.9.9',
  assets: [{ name: 'obn-windows-x64.zip', browser_download_url: 'https://dl.example/obn-windows-x64.zip', size: 123 }],
})

test('isCnLikely：时区/语言判断，也可显式覆盖', () => {
  assert.equal(isCnLikely({ cn: true }), true)
  assert.equal(isCnLikely({ cn: false }), false)
  assert.equal(isCnLikely({ timeZone: 'Asia/Shanghai', locale: 'en-US' }), true)
  assert.equal(isCnLikely({ timeZone: 'Europe/Berlin', locale: 'de-DE' }), false)
  assert.equal(isCnLikely({ timeZone: 'UTC', locale: 'zh-CN' }), true)
})

test('orderUrls：国内先代理、国外先直连，代理都带原始 URL', () => {
  const url = 'https://github.com/x/y.zip'
  const cn = orderUrls(url, { cn: true })
  assert.equal(cn[cn.length - 1], url, '国内把直连放最后')
  assert.equal(cn[0], GH_PROXIES[0] + url)
  const intl = orderUrls(url, { cn: false })
  assert.equal(intl[0], url, '国外先直连')
  assert.equal(intl[1], GH_PROXIES[0] + url)
})

test('代理表首选 githubproxy.cc（实测支持 Range 分段）', () => {
  assert.equal(GH_PROXIES[0], 'https://githubproxy.cc/')
  assert.ok(GH_PROXIES.length >= 2, '要有回退代理')
  const ordered = orderUrls('https://github.com/a/b.zip', { cn: true, proxies: ['https://githubproxy.cc/'] })
  assert.equal(ordered[0], 'https://githubproxy.cc/https://github.com/a/b.zip')
})

test('下载 Windows 包：只解出 lib/vX/BambuSource.dll 并落盘', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'bambu-lib-'))
  try {
    const zip = makeZip([
      { name: 'obn-windows-x64/README.md', data: 'hi' },
      { name: 'obn-windows-x64/lib/v02.09.01/BambuSource.dll', data: DLL },
      { name: 'obn-windows-x64/lib/v02.09.01/bambu_networking.dll', data: 'other' },
    ])
    const f = fakeFetch([
      { match: 'https://api.github.com', body: RELEASE_JSON },
      { match: 'https://dl.example/obn-windows-x64.zip', body: zip },
    ])
    const r = await downloadBambuSource({ destDir: dir, platform: 'win32', cn: false, fetchImpl: f.impl })
    assert.equal(r.ok, true, JSON.stringify(r))
    assert.equal(path.basename(r.path), 'BambuSource.dll')
    const got = await readFile(r.path)
    assert.equal(got.length, DLL.length)
    assert.equal(got.subarray(0, 2).toString(), 'MZ')
    assert.equal(r.version, 'v9.9.9')
    assert.equal(r.proxy, false)
    assert.equal((await stat(r.path)).size, DLL.length)
  } finally { await rm(dir, { recursive: true, force: true }) }
})

test('下载 Linux 包：从 tar.gz 里取 lib/libBambuSource.so', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'bambu-lib-'))
  try {
    const tgz = makeTarGz([
      { name: 'obn-linux-x64/README.md', data: 'hi' },
      { name: 'obn-linux-x64/lib/libBambuSource.so', data: DLL },
      { name: 'obn-linux-x64/bin/obn', data: 'bin' },
    ])
    const f = fakeFetch([
      { match: 'https://api.github.com', body: JSON.stringify({ tag_name: 'v1.2.3', assets: [{ name: 'obn-linux-x64.tar.gz', browser_download_url: 'https://dl.example/obn-linux-x64.tar.gz' }] }) },
      { match: 'https://dl.example/obn-linux-x64.tar.gz', body: tgz },
    ])
    const r = await downloadBambuSource({ destDir: dir, platform: 'linux', cn: false, fetchImpl: f.impl })
    assert.equal(r.ok, true, JSON.stringify(r))
    assert.equal(path.basename(r.path), 'libBambuSource.so')
    assert.equal((await readFile(r.path)).length, DLL.length)
    assert.equal(r.version, 'v1.2.3')
  } finally { await rm(dir, { recursive: true, force: true }) }
})

test('国内 IP：先打代理；代理全挂就回退直连', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'bambu-lib-'))
  try {
    const zip = makeZip([{ name: 'p/lib/v02.09.01/BambuSource.dll', data: DLL }])
    const f = fakeFetch([
      { match: 'https://api.github.com', body: RELEASE_JSON },
      { match: GH_PROXIES[0], fail: 'ECONNRESET' },
      { match: GH_PROXIES[1], fail: 'ETIMEDOUT' },
      { match: 'https://dl.example/obn-windows-x64.zip', body: zip },
    ])
    const r = await downloadBambuSource({ destDir: dir, platform: 'win32', cn: true, fetchImpl: f.impl })
    assert.equal(r.ok, true, JSON.stringify(r))
    assert.equal(r.proxy, false, '最终走的是直连')
    const hosts = f.calls.map((c) => { try { return new URL(c.url).host } catch { return '' } })
    assert.equal(hosts.includes('dl.example'), true)
  } finally { await rm(dir, { recursive: true, force: true }) }
})

test('所有源都失败：给出手动下载链接，不抛异常', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'bambu-lib-'))
  try {
    const f = fakeFetch([
      { match: 'https://api.github.com', fail: 'ENOTFOUND' },
      { match: 'https://github.com', fail: 'ENOTFOUND' },
    ])
    const r = await downloadBambuSource({ destDir: dir, platform: 'win32', cn: false, fetchImpl: f.impl })
    assert.equal(r.ok, false)
    assert.equal(r.code, 'ALL_SOURCES_FAILED')
    assert.match(r.error, /手动下载/)
    assert.ok(r.error.includes(OBN_RELEASES))
  } finally { await rm(dir, { recursive: true, force: true }) }
})

test('压缩包里没有目标文件 / 文件太小 → 明确报错', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'bambu-lib-'))
  try {
    const empty = makeZip([{ name: 'p/readme.txt', data: 'x' }])
    const f1 = fakeFetch([
      { match: 'https://api.github.com', body: RELEASE_JSON },
      { match: 'https://dl.example/obn-windows-x64.zip', body: empty },
    ])
    const r1 = await downloadBambuSource({ destDir: dir, platform: 'win32', cn: false, fetchImpl: f1.impl })
    assert.equal(r1.ok, false)
    assert.match(r1.error, /没有 BambuSource\.dll/)

    const tiny = makeZip([{ name: 'p/lib/v02.09.01/BambuSource.dll', data: Buffer.from('MZ') }])
    const f2 = fakeFetch([
      { match: 'https://api.github.com', body: RELEASE_JSON },
      { match: 'https://dl.example/obn-windows-x64.zip', body: tiny },
    ])
    const r2 = await downloadBambuSource({ destDir: dir, platform: 'win32', cn: false, fetchImpl: f2.impl })
    assert.equal(r2.ok, false)
    assert.match(r2.error, /太小/)
  } finally { await rm(dir, { recursive: true, force: true }) }
})

test('API 拿不到时退回已知版本号', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'bambu-lib-'))
  try {
    const zip = makeZip([{ name: 'p/lib/v02.09.01/BambuSource.dll', data: DLL }])
    const f = fakeFetch([
      { match: 'https://api.github.com', fail: 'ENOTFOUND' },
      { match: 'https://github.com/ClusterM/open-bamboo-networking/releases/download/', body: zip },
    ])
    const r = await downloadBambuSource({ destDir: dir, platform: 'win32', cn: false, fetchImpl: f.impl })
    assert.equal(r.ok, true, JSON.stringify(r))
    assert.equal(r.version, KNOWN_RELEASE)
    const urls = f.calls.map((c) => c.url).join(' ')
    assert.match(urls, new RegExp(KNOWN_RELEASE.replace(/[.]/g, '\\.')))
  } finally { await rm(dir, { recursive: true, force: true }) }
})

test('parseZipCentralDirectory / parseTarEntries 只认目录项', () => {
  const zip = makeZip([{ name: 'a/b.txt', data: 'hello' }])
  const eocdIdx = zip.length - 22
  const cdSize = zip.readUInt32LE(eocdIdx + 12)
  const cdOffset = zip.readUInt32LE(eocdIdx + 16)
  const entries = parseZipCentralDirectory(zip.subarray(cdOffset, cdOffset + cdSize))
  assert.equal(entries.length, 1)
  assert.equal(entries[0].name, 'a/b.txt')
  assert.equal(entries[0].uncompressedSize, 5)

  const tgz = makeTarGz([{ name: 'a/b.txt', data: 'hello' }])
  const tar = gunzipSync(tgz)
  const tarEntries = parseTarEntries(tar)
  assert.equal(tarEntries.length, 1)
  assert.equal(tarEntries[0].size, 5)
})

/* ---------------- review 修复的回归用例 ---------------- */

// 这一段下载下来的是**原生库**，之后要被 dlopen 执行；只判「≥64KB」等于没验。
// 照 modules/phone 的 PT_BY_PLATFORM 做法：版本 + 哈希一起钉死。
test('BambuSource 哈希钉版：查表正确，且正常下载会把算出的 sha256 带回来', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'tutk-sha-'))
  try {
    // 键是「资产名:库名」；表里没有的版本 / 条目一律返回 ''
    assert.equal(expectedLibSha256('v0.0.1-nope', 'obn-windows-x64.zip', 'BambuSource.dll'), '', '不认识的版本没有钉哈希')
    assert.equal(expectedLibSha256(KNOWN_RELEASE, 'obn-windows-x64.zip', 'BambuSource.dll'), '', '已知版本有一行，但这一条目前还没填哈希')
    assert.ok(KNOWN_LIB_SHA256[KNOWN_RELEASE], '已知版本要在表里有一行')
    // 表是冻结的：升级版本必须改代码，不能在运行时被悄悄替换
    assert.equal(Object.isFrozen(KNOWN_LIB_SHA256), true)
    assert.equal(Object.isFrozen(KNOWN_LIB_SHA256[KNOWN_RELEASE]), true)

    const zip = makeZip([{ name: 'obn-windows-x64/lib/v02.09.01/BambuSource.dll', data: DLL }])
    const f = fakeFetch([
      { match: 'https://api.github.com', body: RELEASE_JSON },
      { match: 'https://dl.example/obn-windows-x64.zip', body: zip },
    ])
    const r = await downloadBambuSource({ destDir: dir, platform: 'win32', cn: false, fetchImpl: f.impl })
    assert.equal(r.ok, true, JSON.stringify(r))
    // 没钉哈希的版本：照常落盘，但要如实回报「未校验」和实际哈希
    const { createHash } = await import('node:crypto')
    const want = createHash('sha256').update(DLL).digest('hex')
    assert.equal(r.sha256, want, '结果要带上实际算出来的 sha256（钉表时照着填）')
    assert.equal(r.verified, false, '表里没填哈希时必须如实说没校验，不能假装验过')
  } finally { await rm(dir, { recursive: true, force: true }) }
})

test('resolveDestDir：库文件路径当文件名，目录照旧当目录（P2-3）', () => {
  // 面板把 tutkLibPath 描述成「库文件路径」：不能它再当目录拼一次标准库名
  assert.deepEqual(resolveDestDir('/opt/libBambuSource.so', 'libBambuSource.so'), { dir: '/opt', fileName: 'libBambuSource.so' })
  assert.deepEqual(resolveDestDir('/opt/libs/BambuSource.dll', 'BambuSource.dll'), { dir: '/opt/libs', fileName: 'BambuSource.dll' })
  assert.deepEqual(resolveDestDir('/opt/mylib.dylib', 'libBambuSource.so'), { dir: '/opt', fileName: 'mylib.dylib' })
  // 自定义名字（扩展名是库后缀）也按文件处理
  assert.deepEqual(resolveDestDir('C:\\mods\\my-lib.dll', 'BambuSource.dll'), { dir: 'C:\\mods', fileName: 'my-lib.dll' })
  // 目录：保持原样，文件名用标准名
  assert.deepEqual(resolveDestDir('/opt/libs', 'libBambuSource.so'), { dir: '/opt/libs', fileName: 'libBambuSource.so' })
  assert.deepEqual(resolveDestDir('/opt/libs/', 'libBambuSource.so'), { dir: '/opt/libs/', fileName: 'libBambuSource.so' })
  // 只有文件名没有目录：不回落到 cwd，交给调用方报 NO_DIR
  assert.deepEqual(resolveDestDir('libBambuSource.so', 'libBambuSource.so'), { dir: '', fileName: 'libBambuSource.so' })
  assert.deepEqual(resolveDestDir('', 'libBambuSource.so'), { dir: '', fileName: 'libBambuSource.so' })
})

test('下载到「库文件路径」：写到该文件，不再多套一层目录（P2-3）', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'bambu-lib-'))
  try {
    const zip = makeZip([{ name: 'p/lib/v02.09.01/BambuSource.dll', data: DLL }])
    const f = fakeFetch([
      { match: 'https://api.github.com', body: RELEASE_JSON },
      { match: 'https://dl.example/obn-windows-x64.zip', body: zip },
    ])
    const wanted = path.join(dir, 'libs', 'BambuSource.dll')
    const r = await downloadBambuSource({ destDir: wanted, platform: 'win32', cn: false, fetchImpl: f.impl })
    assert.equal(r.ok, true, JSON.stringify(r))
    assert.equal(r.path, wanted)
    assert.equal((await readFile(wanted)).length, DLL.length)
  } finally { await rm(dir, { recursive: true, force: true }) }
})

test('targetFor：只认 win32+x64 / linux+x64，其它明确不支持（P3-2）', () => {
  assert.equal(targetFor('win32', 'x64').asset, 'obn-windows-x64.zip')
  assert.equal(targetFor('linux', 'x64').libName, 'libBambuSource.so')
  for (const [p, a] of [['darwin', 'arm64'], ['darwin', 'x64'], ['linux', 'arm64'], ['win32', 'arm64'], ['freebsd', 'x64']]) {
    const t = targetFor(p, a)
    assert.equal(t.ok, false, p + '/' + a + ' 不能被当成 Linux x64')
    assert.equal(t.code, 'UNSUPPORTED_PLATFORM')
    assert.match(t.error, /Windows x64 与 Linux x64|自己编译/)
  }
  // 不支持的平台不能偷偷下 Linux 包
  assert.equal(targetFor('darwin', 'arm64').asset, undefined)
})

test('不支持的平台：downloadBambuSource 直接报 UNSUPPORTED_PLATFORM，不发请求（P3-2）', async () => {
  const calls = []
  const f = { impl: async (url) => { calls.push(url); throw new Error('不该发请求') } }
  const r = await downloadBambuSource({ destDir: '/tmp/x', platform: 'darwin', arch: 'arm64', cn: false, fetchImpl: f.impl })
  assert.equal(r.ok, false)
  assert.equal(r.code, 'UNSUPPORTED_PLATFORM')
  assert.equal(calls.length, 0, '不应为不支持的平台发起下载')
})

test('Range 模式：content-range 声明的总大小超上限 → TOO_LARGE，不读 body（P2/P3-1）', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'bambu-lib-'))
  try {
    const huge = MAX_ASSET_BYTES + 1
    let bodyRead = 0
    const f = {
      impl: async (url, init) => {
        // 探测用的 Range 请求返回一个声明巨大的 206
        if (url.startsWith('https://api.github.com')) {
          return { status: 200, headers: new Headers(), text: async () => RELEASE_JSON, arrayBuffer: async () => Buffer.from(RELEASE_JSON) }
        }
        return {
          status: 206,
          headers: new Headers({ 'content-range': 'bytes 0-0/' + huge }),
          arrayBuffer: async () => { bodyRead++; return Buffer.alloc(0) },
          text: async () => '',
          body: { cancel: async () => {} },
        }
      },
    }
    const r = await downloadBambuSource({ destDir: dir, platform: 'win32', cn: false, fetchImpl: f.impl })
    assert.equal(r.ok, false)
    assert.equal(r.code, 'TOO_LARGE', JSON.stringify(r))
    assert.match(r.error, /上限/)
    assert.equal(bodyRead, 0, '超限时不应读响应体')
  } finally { await rm(dir, { recursive: true, force: true }) }
})

/** 造一个中央目录里宣称 enormousSize 的 zip（实际数据只有几字节）。 */
function makeLyingZip (name, realData, declaredUncompressed) {
  const zip = makeZip([{ name, data: realData }])
  const eocd = zip.length - 22
  const cdOffset = zip.readUInt32LE(eocd + 16)
  // 中央目录里 uncompressedSize 在 +24
  zip.writeUInt32LE(declaredUncompressed >>> 0, cdOffset + 24)
  return zip
}

test('ZIP 条目宣称超大 uncompressedSize → 分配/解压前就拒（P2/P3-1）', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'bambu-lib-'))
  try {
    // 声称解压后 3GB；压缩数据只有实际那点字节（注意 4GB 在 uint32 里会回绕成 0）
    const zip = makeLyingZip('p/lib/v02.09.01/BambuSource.dll', DLL, 3 * 1024 * 1024 * 1024)
    const ranges = []
    const f = {
      impl: async (url, init) => {
        if (url.startsWith('https://api.github.com')) {
          return { status: 200, headers: new Headers(), text: async () => RELEASE_JSON, arrayBuffer: async () => Buffer.from(RELEASE_JSON) }
        }
        const range = String(init?.headers?.Range || '')
        ranges.push(range)
        const m = /bytes=(\d+)-(\d+)/.exec(range)
        const start = Number(m[1])
        const end = Math.min(Number(m[2]), zip.length - 1)
        const slice = zip.subarray(start, end + 1)
        return {
          status: 206,
          headers: new Headers({ 'content-range': 'bytes ' + start + '-' + end + '/' + zip.length }),
          arrayBuffer: async () => slice.buffer.slice(slice.byteOffset, slice.byteOffset + slice.length),
          text: async () => slice.toString('utf8'),
          body: null,
        }
      },
    }
    const r = await downloadBambuSource({ destDir: dir, platform: 'win32', cn: false, fetchImpl: f.impl })
    assert.equal(r.ok, false)
    assert.equal(r.code, 'TOO_LARGE', JSON.stringify(r))
    assert.match(r.error, /解压后|上限/)
    // 只读了中央目录，没有去请求那段「4GB」的数据
    assert.ok(ranges.length <= 3, '超限后不该继续按条目大小读取：' + JSON.stringify(ranges))
  } finally { await rm(dir, { recursive: true, force: true }) }
})

/** 造一个能按 Range 切片、并且 body 是「慢慢产出」的 web ReadableStream（不真的联网）。 */
function streamResponse (sliceBuf) {
  let cancelled = false
  let pulled = 0
  const body = new ReadableStream({
    pull (controller) {
      // 故意切成 64KB 小块，模拟慢慢产出：超限时读取方必须提前停
      const step = 64 * 1024
      if (pulled >= sliceBuf.length) { controller.close(); return }
      const next = sliceBuf.subarray(pulled, Math.min(pulled + step, sliceBuf.length))
      pulled += next.length
      controller.enqueue(new Uint8Array(next))
    },
    cancel () { cancelled = true },
  })
  return {
    body,
    stats: () => ({ cancelled, pulled }),
  }
}

/** 一个「对小 Range 请求回超长 body」的 206 服务器桩。 */
function lyingRangeFetch ({ total, makeBody }) {
  const calls = []
  const made = []
  return {
    calls,
    made,
    impl: async (url, init) => {
      calls.push({ url, init })
      if (url.startsWith('https://api.github.com')) {
        return { status: 200, headers: new Headers(), text: async () => RELEASE_JSON, arrayBuffer: async () => Buffer.from(RELEASE_JSON) }
      }
      const range = String(init?.headers?.Range || '')
      const m = /bytes=(\d+)-(\d+)/.exec(range)
      const start = Number(m[1])
      const end = Number(m[2])
      const wanted = end - start + 1
      const { buf, declared } = makeBody(start, wanted)
      const resp = streamResponse(buf)
      // 只记「真正的分段读取」，探测用的 bytes=0-0 不算
      if (wanted > 1) made.push({ start, wanted, bodyBytes: buf.length, ...resp })
      return {
        status: 206,
        headers: new Headers({ 'content-range': declared }),
        ...resp,
      }
    },
  }
}

test('Range 206：body 比请求长度长得多 → TOO_LARGE 且读取中途取消（P2-1）', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'bambu-lib-'))
  try {
    // 声称总大小 2MB（在上限内），但每个 Range 请求都回 2MB 的 body
    const total = 2 * 1024 * 1024
    const f = lyingRangeFetch({
      total,
      makeBody: (start, wanted) => ({
        buf: Buffer.alloc(Math.max(wanted * 20, 2 * 1024 * 1024), 0x41),
        declared: 'bytes ' + start + '-' + (start + wanted - 1) + '/' + total,
      }),
    })
    const r = await downloadBambuSource({ destDir: dir, platform: 'win32', cn: false, fetchImpl: f.impl })
    assert.equal(r.ok, false, JSON.stringify(r))
    assert.equal(r.code, 'TOO_LARGE', JSON.stringify(r))
    assert.match(r.error, /上限/)
    // 至少有一个响应体被中途取消，并且没有把整段超长 body 读完
    assert.ok(f.made.length > 0, '应该有分段 Range 请求')
    const stopped = f.made.filter((x) => x.stats().cancelled)
    assert.ok(stopped.length > 0, '超限后应 cancel 掉底层流')
    const first = f.made[0]
    const firstStats = first.stats()
    assert.ok(firstStats.cancelled, '第一个超长响应应被取消')
    // body 有 2MB，请求只有 ~66KB：读完的字节必须远小于 body，最多比上限多一块 64KB
    assert.ok(firstStats.pulled < first.bodyBytes, '不应读完整个超长 body：' + JSON.stringify({ ...firstStats, bodyBytes: first.bodyBytes }))
    assert.ok(firstStats.pulled <= first.wanted + 3 * 64 * 1024, '应在超过请求长度后立刻停下：' + JSON.stringify({ ...firstStats, wanted: first.wanted }))
  } finally { await rm(dir, { recursive: true, force: true }) }
})

test('Range 206：body 与 content-range 一致 → 成功落盘（P2-1 正常路径）', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'bambu-lib-'))
  try {
    const zip = makeZip([{ name: 'p/lib/v02.09.01/BambuSource.dll', data: DLL }])
    let ranged = 0
    const f = {
      impl: async (url, init) => {
        if (url.startsWith('https://api.github.com')) {
          return { status: 200, headers: new Headers(), text: async () => RELEASE_JSON, arrayBuffer: async () => Buffer.from(RELEASE_JSON) }
        }
        const range = String(init?.headers?.Range || '')
        const m = /bytes=(\d+)-(\d+)/.exec(range)
        const start = Number(m[1])
        const end = Math.min(Number(m[2]), zip.length - 1)
        const slice = zip.subarray(start, end + 1)
        ranged++
        return {
          status: 206,
          headers: new Headers({ 'content-range': 'bytes ' + start + '-' + end + '/' + zip.length }),
          ...streamResponse(slice),
        }
      },
    }
    const r = await downloadBambuSource({ destDir: dir, platform: 'win32', cn: false, fetchImpl: f.impl })
    assert.equal(r.ok, true, JSON.stringify(r))
    assert.ok(ranged > 1, '应该走了多次 Range 读取：' + ranged)
    assert.equal((await readFile(r.path)).length, DLL.length)
  } finally { await rm(dir, { recursive: true, force: true }) }
})

test('Range 206：content-range 声明与实读长度不一致 → 报协议错误（P2-1）', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'bambu-lib-'))
  try {
    // 声明 4 字节、实际给 100 字节（都在请求长度内），不静默通过
    const total = 4096
    const f = lyingRangeFetch({
      total,
      makeBody: (start, wanted) => ({
        buf: Buffer.alloc(100, 0x42),
        declared: 'bytes ' + start + '-' + (start + 3) + '/' + total,
      }),
    })
    const r = await downloadBambuSource({ destDir: dir, platform: 'win32', cn: false, fetchImpl: f.impl })
    assert.equal(r.ok, false, JSON.stringify(r))
    assert.equal(r.code, 'PROTOCOL', '声明与实读不一致必须是独立错误码：' + JSON.stringify(r))
    assert.match(r.error, /content-range|响应不合法/)
  } finally { await rm(dir, { recursive: true, force: true }) }
})

test('自定义文件名：fileName 覆盖标准库名，path 就是落盘路径（P2-2）', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'bambu-lib-'))
  try {
    const zip = makeZip([{ name: 'p/lib/v02.09.01/BambuSource.dll', data: DLL }])
    const f = fakeFetch([
      { match: 'https://api.github.com', body: RELEASE_JSON },
      { match: 'https://dl.example/obn-windows-x64.zip', body: zip },
    ])
    const r = await downloadBambuSource({ destDir: dir, fileName: 'custom-source.dll', platform: 'win32', cn: false, fetchImpl: f.impl })
    assert.equal(r.ok, true, JSON.stringify(r))
    assert.equal(r.path, path.join(dir, 'custom-source.dll'), '返回的 path 应含自定义名')
    assert.equal(path.basename(r.path), 'custom-source.dll')
    assert.equal((await readFile(r.path)).length, DLL.length)
    // 标准名不应该被写出来
    await assert.rejects(() => stat(path.join(dir, 'BambuSource.dll')))
  } finally { await rm(dir, { recursive: true, force: true }) }
})

test('自定义库文件路径：/{dir}/{fileName} 分开传也写到自定义名（P2-2）', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'bambu-lib-'))
  try {
    const tgz = makeTarGz([{ name: 'obn-linux-x64/lib/libBambuSource.so', data: DLL }])
    const f = fakeFetch([
      { match: 'https://api.github.com', body: JSON.stringify({ tag_name: 'v1.2.3', assets: [{ name: 'obn-linux-x64.tar.gz', browser_download_url: 'https://dl.example/obn-linux-x64.tar.gz' }] }) },
      { match: 'https://dl.example/obn-linux-x64.tar.gz', body: tgz },
    ])
    // 路由现在应该这样调：{ destDir: resolved.dir, fileName: resolved.fileName }
    const resolved = resolveDestDir(path.join(dir, 'libs', 'custom-source.so'), 'libBambuSource.so')
    assert.deepEqual(resolved, { dir: path.join(dir, 'libs'), fileName: 'custom-source.so' })
    const r = await downloadBambuSource({ destDir: resolved.dir, fileName: resolved.fileName, platform: 'linux', cn: false, fetchImpl: f.impl })
    assert.equal(r.ok, true, JSON.stringify(r))
    assert.equal(r.path, path.join(dir, 'libs', 'custom-source.so'))
  } finally { await rm(dir, { recursive: true, force: true }) }
})

test('不传 fileName：仍落盘标准 BAMBUSOURCE 库名（P2-2 回归）', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'bambu-lib-'))
  try {
    const zip = makeZip([{ name: 'p/lib/v02.09.01/BambuSource.dll', data: DLL }])
    const f = fakeFetch([
      { match: 'https://api.github.com', body: RELEASE_JSON },
      { match: 'https://dl.example/obn-windows-x64.zip', body: zip },
    ])
    const r = await downloadBambuSource({ destDir: dir, platform: 'win32', cn: false, fetchImpl: f.impl })
    assert.equal(r.ok, true, JSON.stringify(r))
    assert.equal(path.basename(r.path), 'BambuSource.dll')
    assert.equal(r.path, path.join(dir, 'BambuSource.dll'))
    // 带路径的 fileName 要拒绝，别让它写出去
    const bad = await downloadBambuSource({ destDir: dir, fileName: '../evil.dll', platform: 'win32', cn: false, fetchImpl: f.impl })
    assert.equal(bad.ok, false)
    assert.equal(bad.code, 'BAD_FILENAME')
  } finally { await rm(dir, { recursive: true, force: true }) }
})

test('gzip 解压也有上限：maxUncompressedBytes 生效（P2/P3-1）', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'bambu-lib-'))
  try {
    const tgz = makeTarGz([{ name: 'obn-linux-x64/lib/libBambuSource.so', data: DLL }])
    const f = fakeFetch([
      { match: 'https://api.github.com', body: JSON.stringify({ tag_name: 'v1.2.3', assets: [{ name: 'obn-linux-x64.tar.gz', browser_download_url: 'https://dl.example/obn-linux-x64.tar.gz' }] }) },
      { match: 'https://dl.example/obn-linux-x64.tar.gz', body: tgz },
    ])
    const r = await downloadBambuSource({ destDir: dir, platform: 'linux', cn: false, fetchImpl: f.impl, maxUncompressedBytes: 1024 })
    assert.equal(r.ok, false)
    assert.equal(r.code, 'TOO_LARGE', JSON.stringify(r))
  } finally { await rm(dir, { recursive: true, force: true }) }
})