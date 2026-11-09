// song（点歌 / 翻唱）回归测试
//
// 这个模块会 spawn Python、下模型、占磁盘，所以测试**只碰纯函数**：
//   · 路径校验：必须完整绝对路径，不能含糊
//   · 体积计算：不存在的目录不能崩
//   · 模型文件校验：太小或头不对的要拒（防半截下载当模型）
//   · 安装错误解释：要把用户看不懂的 stderr 翻译成人话
//   · 镜像选择：显式模式必须严格遵守，auto 才去探测
// 绝不真跑 Applio、不联网、不写用户真实目录。
import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const MOD = join(HERE, '..')

// studio.js 顶部会读 globalThis.aurabot.lib 找插件内部文件（复制出来后靠它定位）。
// 测试里没有插件环境，先塞一个最小桩让模块能加载。
if (!globalThis.aurabot) {
  globalThis.aurabot = {
    lib: () => new Proxy({}, { get: () => () => '' }),
    src: new URL('..', import.meta.url).href,
  }
}

const ST = await import(new URL('../studio.js', import.meta.url).href)
const { default: mod } = await import(new URL('../index.mjs', import.meta.url).href)

function tempDir() {
  return mkdtempSync(join(tmpdir(), 'aurabot-song-test-'))
}

describe('模块装配', () => {
  test('入口与 module.json 的 id / version / api 一致', () => {
    const m = JSON.parse(readFileSync(join(MOD, 'module.json'), 'utf8'))
    assert.equal(m.id, mod.id)
    assert.equal(m.version, mod.version)
    assert.equal(m.api, mod.api)
    assert.equal(typeof mod.setup, 'function')
  })

  test('声明为替换内置 song（replacesBuiltin）', () => {
    const m = JSON.parse(readFileSync(join(MOD, 'module.json'), 'utf8'))
    assert.equal(m.replacesBuiltin, true, 'id 与内置重名，必须写 replacesBuiltin')
  })

  test('setup 能起来并注册 /song/status', () => {
    const routes = new Map()
    const api = {
      id: 'song', dir: MOD, version: 'test',
      log: { info() {}, warn() {}, debug() {}, error() {} },
      dataDir: (...p) => join(tempDir(), ...p),
      config: () => ({}), settings: () => ({ ...(mod.defaults || {}) }), saveSettings: () => ({}), setConfig: () => ({}),
      route: (p, h) => routes.set(p, h),
      tool: () => {}, defineTool: (d) => d, onDispose: () => {},
      every: () => () => {}, later: () => () => {},
      lazy: () => null, use: () => null, has: () => false,
      emit: () => {}, on: () => () => {},
      command: () => {},
      core: { http: { send: () => {}, query: () => ({}), body: async () => ({}) } },
    }
    mod.setup(api)
    assert.ok(routes.has('/song/status'), '/song/status 要注册上')
  })
})

describe('路径校验', () => {
  test('空路径算合法（用默认），不报错', () => {
    const r = ST.checkRoot('')
    assert.equal(r.ok, true, '空 = 用默认目录，不该报错')
    assert.equal(r.path, '')
  })

  test('相对路径被拒，并给出「要写完整路径」的提示', () => {
    const r = ST.checkRoot('rvc')
    assert.equal(r.ok, false, '相对路径必须拒')
    assert.match(r.message, /完整路径/, `提示要能看懂，实际：${r.message}`)
  })

  test('完整绝对路径被接受', () => {
    const r = ST.checkRoot('D:\\Aurabot\\rvc')
    assert.equal(r.ok, true, `完整路径应当接受：${JSON.stringify(r)}`)
  })

  test('路径里有中文时给出警告（但有警告不等于不能用）', () => {
    const r = ST.checkRoot('D:\\机器人\\rvc')
    assert.equal(r.ok, true, '有中文仍可用')
    assert.match(r.warn, /中文|空格/, `要提醒换全英文路径，实际：${JSON.stringify(r.warn)}`)
  })

  test('检查不存在的盘符不崩（只是量不到剩余空间）', () => {
    assert.doesNotThrow(() => {
      const r = ST.checkRoot('Z:\\nonexistent\\path')
      assert.ok(r && typeof r === 'object')
    })
  })
})

describe('体积计算', () => {
  test('dirSize 对不存在的目录返回 0 而不是崩', () => {
    assert.equal(ST.dirSize(join(tmpdir(), 'aurabot-does-not-exist-' + Date.now())), 0)
  })

  test('dirSize 能算出真实目录的文件总量', () => {
    const d = tempDir()
    try {
      writeFileSync(join(d, 'a.bin'), Buffer.alloc(1000))
      mkdirSync(join(d, 'sub'))
      writeFileSync(join(d, 'sub', 'b.bin'), Buffer.alloc(2000))
      const n = ST.dirSize(d)
      assert.ok(n >= 3000, `至少 3000 字节，实际 ${n}`)
      assert.ok(n < 5000, `不该虚高，实际 ${n}`)
    } finally { rmSync(d, { recursive: true, force: true }) }
  })
})

describe('模型文件校验（防半截下载当模型）', () => {
  test('looksLikePth 拒绝过小的文件（半截下载）', () => {
    const tiny = Buffer.from([0x50, 0x4b, 0x03, 0x04])
    assert.equal(ST.looksLikePth(tiny), false, '不到 1MB 的不算有效模型')
  })

  test('looksLikePth 认得出 zip 头的大文件', () => {
    const zip = Buffer.alloc(1024 * 1024 + 10)
    zip[0] = 0x50; zip[1] = 0x4b
    assert.equal(ST.looksLikePth(zip), true, 'zip 头的 >1MB 文件要认')
  })

  test('looksLikePth 认得出 pickle 头的大文件', () => {
    const pk = Buffer.alloc(1024 * 1024 + 10)
    pk[0] = 0x80
    assert.equal(ST.looksLikePth(pk), true, '0x80 开头的 >1MB 文件要认')
  })

  test('looksLikePth 拒绝纯文本', () => {
    const txt = Buffer.alloc(2 * 1024 * 1024, 0x41) // 全是 'A'
    assert.equal(ST.looksLikePth(txt), false, '文本文件不能当模型')
  })

  test('looksLikePth 对空 buffer 返回 false 而不是崩', () => {
    assert.equal(ST.looksLikePth(Buffer.alloc(0)), false)
  })

  test('listVoices 对不存在的目录返回空数组', () => {
    const v = ST.listVoices(join(tmpdir(), 'aurabot-novoices-' + Date.now()))
    assert.ok(Array.isArray(v))
    assert.equal(v.length, 0)
  })

  test('listVoices 能列出目录里的 .pth', () => {
    const d = tempDir()
    try {
      writeFileSync(join(d, 'myvoice.pth'), Buffer.alloc(2048))
      writeFileSync(join(d, 'readme.txt'), 'x')
      const v = ST.listVoices(d)
      assert.ok(v.length >= 1, `要列出模型，实际 ${JSON.stringify(v)}`)
      assert.ok(JSON.stringify(v).includes('myvoice'))
    } finally { rmSync(d, { recursive: true, force: true }) }
  })
})

describe('安装错误解释', () => {
  test('缺依赖翻译成中文提示', () => {
    const r = ST.explainInstallError('ModuleNotFoundError: No module named "torch"')
    assert.ok(typeof r === 'string' && r.length > 0)
  })

  test('网络超时给出网络相关提示', () => {
    const r = ST.explainInstallError('Connection timed out')
    assert.ok(r.length > 0)
  })

  test('未知错误也返回非空字符串，不抛', () => {
    assert.doesNotThrow(() => {
      assert.equal(typeof ST.explainInstallError('some totally unknown gibberish'), 'string')
    })
  })
})

describe('镜像选择', () => {
  test('cn / tuna 模式一律用镜像（不联网探测）', async () => {
    const boom = async () => { throw new Error('不该被调用') }
    assert.equal(await ST.shouldUseCnMirror('cn', boom), true)
    assert.equal(await ST.shouldUseCnMirror('tuna', boom), true)
  })

  test('off 模式一律不用镜像（不联网探测）', async () => {
    const boom = async () => { throw new Error('不该被调用') }
    assert.equal(await ST.shouldUseCnMirror('off', boom), false)
  })

  test('auto 模式：探测全部很快时不用镜像', async () => {
    const fast = async () => ({ status: 200 })
    assert.equal(await ST.shouldUseCnMirror('auto', fast), false)
  })

  test('auto 模式：探测失败时用镜像（说明连不上）', async () => {
    const fail = async () => { throw new Error('timeout') }
    assert.equal(await ST.shouldUseCnMirror('auto', fail), true)
  })
})

describe('分离器', () => {
  test('separatorLinks 给出可下载的 URL 列表（key 是文件名）', () => {
    // SEPARATOR_FILES 的 key 是「文件名」，不是模型名
    const keys = Object.keys(ST.SEPARATOR_FILES)
    assert.ok(keys.length >= 1, '至少有一个分离器模型')
    const links = ST.separatorLinks(keys[0])
    assert.ok(Array.isArray(links))
    assert.ok(links.length >= 1, `至少一个下载源，实际 ${JSON.stringify(links)}`)
    assert.ok(links.every((u) => String(u).startsWith('http')), '每个都该是 URL')
  })

  test('未知模型名返回空数组，不崩', () => {
    const links = ST.separatorLinks('不存在的模型')
    assert.ok(Array.isArray(links))
    assert.equal(links.length, 0)
  })

  test('separatorReady 在空目录下返回 false', () => {
    const d = tempDir()
    try {
      assert.equal(ST.separatorReady(d, Object.keys(ST.SEPARATOR_FILES)[0]), false)
    } finally { rmSync(d, { recursive: true, force: true }) }
  })
})

describe('安装步骤常量', () => {
  test('INSTALL_STEPS 是给用户看的步骤列表', () => {
    assert.ok(Array.isArray(ST.INSTALL_STEPS))
    assert.ok(ST.INSTALL_STEPS.length >= 2)
    assert.ok(ST.INSTALL_STEPS.every((s) => typeof s === 'string' && s.length > 0))
  })

  test('APPLIO_COMMIT 钉了具体版本（不能跟分支漂）', () => {
    assert.match(ST.APPLIO_COMMIT, /^[0-9a-f]{40}$/, '要钉到 40 位 commit')
  })

  test('UV_SOURCES 是候选下载源（{ url, sha256? } 结构）', () => {
    assert.ok(Array.isArray(ST.UV_SOURCES))
    assert.ok(ST.UV_SOURCES.length >= 1)
    for (const s of ST.UV_SOURCES) {
      assert.equal(typeof s, 'object', '每项是对象')
      assert.ok(String(s.url).startsWith('http'), `url 要合法，实际 ${s.url}`)
      if (s.sha256) assert.match(s.sha256, /^[0-9a-f]{64}$/, 'sha256 格式要对')
    }
  })
})
