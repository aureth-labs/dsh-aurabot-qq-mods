// 仓库脚本共用的东西：读模块、校验 module.json、扫描能力、打包 zip。不依赖任何 npm 包。

import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, relative, sep } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { crc32, deflateRawSync } from 'node:zlib'

export const ROOT = fileURLToPath(new URL('../', import.meta.url))
export const MODULES_DIR = join(ROOT, 'modules')
export const BUILTINS = JSON.parse(readFileSync(new URL('./builtins.json', import.meta.url), 'utf8'))
export const MAX_PACKAGE_BYTES = 20 * 1024 * 1024

// 和插件 src/core/modules.js 的规则保持一致
const ID_RE = /^[a-z][a-z0-9-]{1,39}$/
const VERSION_RE = /^\d+\.\d+\.\d+$/
const ENTRY = ['index.mjs', 'index.js']
const SKIP_DIRS = new Set(['node_modules', '.git', '.build', '.runtime', '.aurabot-cache', 'test', 'tests', 'fixtures', '__tests__'])
const SKIP_FILE = /(\.test\.[cm]?[jt]s|^package-lock\.json|^\.gitignore)$/

// 能力声明：给审核者和安装页看的，不是沙箱。模块和插件同进程，这里拦不住恶意代码。
export const CAPABILITIES = {
  network: { label: '联网', re: /\bfetch\(|node:(https?|net|tls|dgram)|from ['"](https?|net|tls)['"]|\bWebSocket\b/ },
  filesystem: { label: '读写本机文件', re: /node:fs|from ['"]fs['"]|require\(['"]fs['"]\)/ },
  process: { label: '启动其他程序', re: /child_process|process\.dlopen|node:worker_threads/ },
  'dynamic-code': { label: '动态执行代码', re: /\beval\(|new Function\b|node:vm|require\(['"]vm['"]\)/ },
  'plugin-config': { label: '读写插件配置（含账号 Cookie）', re: /\bapi\.(config|setConfig)\(/ },
  'plugin-internals': { label: '使用插件内部对象', re: /\bapi\.(core|lib|dsh)\b|globalThis\.aurabot/ },
}

// 分类决定模块在市场和目录里的位置。不够用就在这里加一项，别新建目录层级：
// 文件夹永远是 modules/<id>/，换分类不用搬目录，发布 tag 和安装路径都不变。
export const CATEGORIES = {
  platform: '逛平台',
  social: '聊天互动',
  creative: '创作',
  desktop: '桌面',
  manage: '管理',
  tool: '工具',
}
const ROOT_FILES = /^(module\.json|index\.m?js|panel\.js|package(-lock)?\.json|.*\.md|LICENSE.*)$/i
const ROOT_DIRS = new Set(['lib', 'test', 'assets', 'docs'])

export const compareVersions = (a, b) => {
  const x = String(a).split('.').map(Number)
  const y = String(b).split('.').map(Number)
  for (let i = 0; i < 3; i++) if (x[i] !== y[i]) return x[i] > y[i] ? 1 : -1
  return 0
}
export const tagOf = (id, version) => `${id}-v${version}`
export const entryOf = (dir) => ENTRY.find((name) => existsSync(join(dir, name))) || ''

/** modules/ 下的模块（_ 和 . 开头的目录跳过，和插件加载规则一样）。 */
export function listModules(dir = MODULES_DIR) {
  if (!existsSync(dir)) return []
  return readdirSync(dir, { withFileTypes: true })
    .filter((e) => e.isDirectory() && !/^[_.]/.test(e.name))
    .map((e) => ({ id: e.name, dir: join(dir, e.name) }))
    .sort((a, b) => a.id.localeCompare(b.id))
}

export function readManifest(dir) {
  return JSON.parse(readFileSync(join(dir, 'module.json'), 'utf8'))
}

/** 校验 module.json，返回错误列表。known 是可以依赖的模块 id。 */
export function validateManifest(m, id, known = new Set(BUILTINS)) {
  const errors = []
  const text = (key) => { if (typeof m[key] !== 'string' || !m[key].trim()) errors.push(`${key} 必填`) }
  for (const key of ['name', 'description', 'author', 'license']) text(key)
  if (!ID_RE.test(String(m.id || ''))) errors.push(`id「${m.id ?? ''}」不对：小写字母开头，只能有小写字母、数字和 -，2~40 个字`)
  if (m.id !== id) errors.push(`id「${m.id ?? ''}」要和文件夹名「${id}」一样`)
  if (!CATEGORIES[m.category]) errors.push(`category 要从这些里选：${Object.keys(CATEGORIES).join('、')}`)
  if (m.tags !== undefined && !(Array.isArray(m.tags) && m.tags.length <= 5 && m.tags.every((t) => typeof t === 'string' && t.trim()))) errors.push('tags 要是字符串数组，最多 5 个')
  if (!VERSION_RE.test(String(m.version || ''))) errors.push('version 要写成 1.2.3')
  if (!Number.isInteger(m.api) || m.api < 1) errors.push('api 要写按哪一版扩展接口开发的（整数）')
  if (!VERSION_RE.test(String(m.minPluginVersion || ''))) errors.push('minPluginVersion 要写成 1.2.3')
  if (!Array.isArray(m.requires)) errors.push('requires 要是数组（没有依赖写 []）')
  else for (const dep of m.requires) if (!known.has(dep)) errors.push(`requires 里的「${dep}」不是内置模块，也不在本仓库`)
  if (!Array.isArray(m.capabilities)) errors.push('capabilities 要是数组（什么都不用写 []）')
  else for (const cap of m.capabilities) if (!CAPABILITIES[cap]) errors.push(`capabilities 里的「${cap}」不认识，可选：${Object.keys(CAPABILITIES).join('、')}`)
  if (BUILTINS.includes(id) && m.replacesBuiltin !== true) errors.push(`「${id}」是内置模块的 id，要替换它必须写 "replacesBuiltin": true`)
  if (!BUILTINS.includes(id) && m.replacesBuiltin) errors.push('replacesBuiltin 只能用在和内置模块同名的模块上')
  if (m.build !== undefined && (typeof m.build?.out !== 'string' || !/^[\w.-]+$/.test(m.build.out))) errors.push('build.out 要写构建产物的文件夹名，比如 ".build"')
  return errors
}

/** 模块发布时带的文件（不含测试和依赖）。相对路径，统一用 /。 */
export function filesOf(dir, base = dir, out = []) {
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    if (e.isSymbolicLink()) throw new Error(`不允许符号链接：${relative(base, join(dir, e.name))}`)
    if (e.isDirectory()) { if (!SKIP_DIRS.has(e.name)) filesOf(join(dir, e.name), base, out) }
    else if (e.isFile() && !SKIP_FILE.test(e.name)) out.push(relative(base, join(dir, e.name)).split(sep).join('/'))
  }
  return out.sort()
}

/** 源码里实际用到的能力。 */
export function scanCapabilities(dir) {
  const code = filesOf(dir).filter((f) => /\.([cm]?[jt]s|html)$/.test(f)).map((f) => readFileSync(join(dir, f), 'utf8')).join('\n')
  return Object.keys(CAPABILITIES).filter((cap) => CAPABILITIES[cap].re.test(code))
}

/** 单个模块的全部静态检查。 */
export function checkModule(mod, known) {
  const errors = []
  const warnings = []
  if (!existsSync(join(mod.dir, 'module.json'))) return { errors: ['缺 module.json'], warnings }
  let m
  try { m = readManifest(mod.dir) } catch (error) { return { errors: [`module.json 读不了：${error.message}`], warnings } }
  errors.push(...validateManifest(m, mod.id, known))
  for (const name of ['README.md', 'LICENSE']) if (!existsSync(join(mod.dir, name))) errors.push(`缺 ${name}`)
  if (!entryOf(mod.dir)) errors.push('缺入口文件 index.mjs 或 index.js')
  for (const e of readdirSync(mod.dir, { withFileTypes: true })) {
    if (e.isFile() && !ROOT_FILES.test(e.name)) warnings.push(`${e.name} 建议放进 lib/ 或 assets/，模块根目录只留入口和说明`)
    if (e.isDirectory() && !ROOT_DIRS.has(e.name) && !/^[._]/.test(e.name) && e.name !== 'node_modules' && e.name !== 'pet-client') warnings.push(`文件夹 ${e.name}/ 建议归到 lib/、assets/、docs/ 或 test/`)
  }
  // 自定义面板 panel.js：插件是用 new Function(body) 跑它的（整文件即函数体，含顶层 return），
  // 所以入口的 import 检查覆盖不到它。这里按同一种方式解析一遍——括号/引号错位当场就红，
  // 不用等用户打开面板才看见「Unexpected token ')'」（phone 0.2.0 就这么漏过一版）。
  const panelFile = join(mod.dir, 'panel.js')
  if (existsSync(panelFile)) {
    const source = readFileSync(panelFile, 'utf8')
    try {
      new Function(source) // eslint-disable-line no-new-func
    } catch (error) {
      errors.push(`panel.js 语法错误（面板会加载失败：${error.message}）`)
    }
  }
  const pkg = existsSync(join(mod.dir, 'package.json')) ? JSON.parse(readFileSync(join(mod.dir, 'package.json'), 'utf8')) : null
  if (Object.keys(pkg?.dependencies || {}).length && !m.build) errors.push('有 npm 依赖的模块必须配 build 打成独立运行包：用户机器上不跑 npm install')
  if (m.build && !pkg?.scripts?.build) errors.push('配了 build，package.json 里要有 scripts.build')
  try {
    const found = scanCapabilities(mod.dir)
    const declared = new Set(Array.isArray(m.capabilities) ? m.capabilities : [])
    for (const cap of found) if (!declared.has(cap)) errors.push(`代码用到了「${CAPABILITIES[cap].label}」，capabilities 要声明 ${cap}`)
    for (const cap of declared) if (!found.includes(cap)) warnings.push(`声明了 ${cap}，但扫描没发现（确认一下是不是多写了）`)
  } catch (error) { errors.push(error.message) }
  return { errors, warnings }
}

export function checkRevoked(list) {
  if (!Array.isArray(list)) return ['revoked.json 要是数组']
  return list.flatMap((r, i) => (r && ID_RE.test(String(r.id)) && Array.isArray(r.versions) && r.versions.every((v) => VERSION_RE.test(v)) && r.reason ? [] : [`revoked.json 第 ${i + 1} 条要有 id、versions、reason`]))
}

/** 打 zip：顺序和时间固定，同样的内容永远得到同样的字节和 sha256。 */
export function makeZip(files) {
  const locals = []
  const centrals = []
  let offset = 0
  for (const [name, data] of [...files].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))) {
    const path = Buffer.from(name, 'utf8')
    const body = deflateRawSync(data, { level: 9 })
    const head = Buffer.alloc(30)
    head.writeUInt32LE(0x04034b50, 0)
    head.writeUInt16LE(20, 4)
    head.writeUInt16LE(0x0800, 6) // 文件名是 UTF-8
    head.writeUInt16LE(8, 8) // deflate
    head.writeUInt16LE(0x21, 12) // 1980-01-01
    head.writeUInt32LE(crc32(data), 14)
    head.writeUInt32LE(body.length, 18)
    head.writeUInt32LE(data.length, 22)
    head.writeUInt16LE(path.length, 26)
    const central = Buffer.alloc(46)
    central.writeUInt32LE(0x02014b50, 0)
    central.writeUInt16LE(20, 4)
    head.copy(central, 6, 4, 30)
    central.writeUInt32LE(offset, 42)
    locals.push(head, path, body)
    centrals.push(central, path)
    offset += head.length + path.length + body.length
  }
  const dir = Buffer.concat(centrals)
  const end = Buffer.alloc(22)
  end.writeUInt32LE(0x06054b50, 0)
  end.writeUInt16LE(files.size, 8)
  end.writeUInt16LE(files.size, 10)
  end.writeUInt32LE(dir.length, 12)
  end.writeUInt32LE(offset, 16)
  return Buffer.concat([...locals, dir, end])
}

function run(cmd, args, cwd) {
  // Windows 上 npm 是 .cmd，要走 shell；参数都是写死的
  execFileSync(cmd, args, { cwd, stdio: ['ignore', 'pipe', 'inherit'], shell: process.platform === 'win32' })
}

/** 模块发布内容：路径 → Buffer。配了 build 的先构建，用产物。 */
export function collect(mod, m = readManifest(mod.dir)) {
  let dir = mod.dir
  if (m.build) {
    run('npm', ['ci', '--ignore-scripts'], mod.dir)
    run('npm', ['run', 'build'], mod.dir)
    dir = join(mod.dir, m.build.out)
    if (!existsSync(dir)) throw new Error(`构建后没有 ${m.build.out}/`)
  }
  const files = new Map(filesOf(dir).map((f) => [f, readFileSync(join(dir, f))]))
  files.set('module.json', readFileSync(join(mod.dir, 'module.json')))
  for (const name of ['LICENSE', 'README.md']) if (!files.has(name)) files.set(name, readFileSync(join(mod.dir, name)))
  return files
}

/** 把发布内容放到临时目录真正加载一次，确认入口能跑通、和 module.json 对得上。 */
export function smokeTest(files, m) {
  const tmp = mkdtempSync(join(tmpdir(), 'aurabot-mod-'))
  try {
    for (const [name, data] of files) {
      mkdirSync(dirname(join(tmp, name)), { recursive: true })
      writeFileSync(join(tmp, name), data)
    }
    const entry = entryOf(tmp)
    if (!entry) return ['发布内容里没有入口文件']
    // src 要给真实目录：模块会写 fileURLToPath(new URL(..., globalThis.aurabot.src))，
    // 硬编码 file:/// 在 Windows 上直接 ERR_INVALID_FILE_URL_PATH（file:/// 没有盘符）。
    const srcUrl = pathToFileURL(join(tmp, sep)).href
    const script = `globalThis.aurabot={lib:()=>new Proxy({},{get:()=>()=>{}}),src:${JSON.stringify(srcUrl)}};const d=(await import(${JSON.stringify(pathToFileURL(join(tmp, entry)).href)})).default;console.log('@@'+JSON.stringify({id:d?.id,version:d?.version,api:d?.api,setup:typeof d?.setup}));process.exit(0)`
    let out
    try { out = execFileSync(process.execPath, ['--input-type=module', '-e', script], { cwd: tmp, encoding: 'utf8', timeout: 30_000, stdio: ['ignore', 'pipe', 'pipe'] }) } catch (error) { return [`入口加载失败：${String(error.stderr || error.message).slice(0, 500)}`] }
    const got = JSON.parse(out.split('\n').find((l) => l.startsWith('@@')).slice(2))
    const errors = []
    if (got.setup !== 'function') errors.push('入口要 export default 一个带 setup(api) 的对象')
    for (const key of ['id', 'version', 'api']) if (got[key] !== m[key]) errors.push(`入口的 ${key}（${got[key]}）和 module.json（${m[key]}）不一样`)
    return errors
  } finally { rmSync(tmp, { recursive: true, force: true }) }
}

/** 打包一个模块，返回给 index.json 用的条目（不含 commit 和 publishedAt）。 */
export function packModule(mod, outDir) {
  const m = readManifest(mod.dir)
  const files = collect(mod, m)
  const errors = smokeTest(files, m)
  if (errors.length) throw new Error(`模块「${mod.id}」：${errors.join('；')}`)
  const zip = makeZip(files)
  if (zip.length > MAX_PACKAGE_BYTES) throw new Error(`模块「${mod.id}」打包后 ${zip.length} 字节，超过上限 ${MAX_PACKAGE_BYTES}`)
  const tag = tagOf(m.id, m.version)
  const file = `${tag}.zip`
  mkdirSync(outDir, { recursive: true })
  writeFileSync(join(outDir, file), zip)
  const { id, name, version, description, category, author, license, api, minPluginVersion, requires, capabilities } = m
  return { id, name, version, description, category, tags: m.tags || [], author, license, api, minPluginVersion, requires, capabilities, replacesBuiltin: Boolean(m.replacesBuiltin), ...(m.homepage ? { homepage: m.homepage } : {}), tag, file, path: `${tag}/${file}`, size: zip.length, sha256: createHash('sha256').update(zip).digest('hex') }
}

/** 按这次打包结果和现有模块生成新的索引。删掉目录的模块自动下架；内容没变就原样返回。 */
export function mergeIndex({ previous, built, present, revoked, assetsBase, now, commit }) {
  const entries = new Map((previous?.modules || []).map((e) => [e.id, e]))
  for (const e of built) entries.set(e.id, { ...e, commit, publishedAt: now })
  const modules = [...entries.values()].filter((e) => present.includes(e.id)).sort((a, b) => a.id.localeCompare(b.id))
  const body = { schema: 1, assetsBase, modules, revoked }
  if (previous && JSON.stringify({ ...previous, generatedAt: undefined }) === JSON.stringify({ ...body, generatedAt: undefined })) return previous
  return { ...body, generatedAt: now }
}
