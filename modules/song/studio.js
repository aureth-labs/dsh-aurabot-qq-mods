// 从 Aurabot v1.1.9 的内置模块「翻唱」复制出来的，改了就替换内置的。
// 原文件：src/song/studio.js
const __lib = globalThis.aurabot.lib // 插件内部源码（复制出来后靠它找到插件里的文件）
// 翻唱：点歌 → 下载（B 站优先，网易云兜底）→ 分离人声和伴奏 → RVC 换成她的声音 → 混音 → 截成语音条发回去。
// 推理引擎用 Applio（MIT，固定版本），人声分离用 audio-separator，都装在一个独立的 Python 环境里，不碰系统环境。

import { spawn } from 'node:child_process'
import { existsSync, mkdirSync, readdirSync, statSync, statfsSync, writeFileSync, readFileSync, rmSync, linkSync, copyFileSync, renameSync, openSync, readSync, closeSync } from 'node:fs'
import { join, basename, dirname, isAbsolute, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { homedir } from 'node:os'
import { createHash } from 'node:crypto'
const { dataDir, readJson, writeJson } = __lib('core/store.js')
const { searchSongs, songUrl, account } = __lib('song/netease.js')
const { readZip } = __lib('song/zip.js')
import { downloadBiliSong } from './bili.js'

export const APPLIO_REPO = 'https://github.com/IAHispano/Applio.git'
export const APPLIO_COMMIT = 'c817f1f83f689ef72e0dfeb1c17ae990b9248506'
const TORCH_INDEX = 'https://download.pytorch.org/whl/cu128'
// 国内镜像：PyPI 和 PyTorch 都用阿里云（PyTorch 那边是文件列表，用 --find-links；Applio 固定了 torch 版本，挑得到 cu128 的），Python 本体用 npmmirror
const CN_PYPI = 'https://mirrors.aliyun.com/pypi/simple'
const CN_TORCH = 'https://mirrors.aliyun.com/pytorch-wheels/cu128/'
const CN_PYTHON = 'https://registry.npmmirror.com/-/binary/python-build-standalone'

/** 自动模式下判断要不要用国内镜像：官方源 4 秒内连不上或者很慢就用。 */
export async function shouldUseCnMirror(mode, fetchImpl = fetch) {
  if (mode === 'cn' || mode === 'tuna') return true
  if (mode === 'off') return false
  const probe = async (url) => {
    const t = Date.now()
    try {
      const r = await fetchImpl(url, { method: 'HEAD', signal: AbortSignal.timeout(4000) })
      return r.status < 500 ? Date.now() - t : Infinity
    } catch (error) {
      return Infinity
    }
  }
  const times = await Promise.all([probe('https://pypi.org/simple/pip/'), probe(TORCH_INDEX + '/torch/'), probe('https://github.com/')])
  return times.some((t) => t > 2500)
}
const LEGACY_ROOT = 'C:\\Aurabot\\rvc'

// RVC 推理要的预训练文件（Applio 放在 HuggingFace 上）：[远端相对路径, 本地相对 Applio 的路径]
const PREREQS = [
  ['predictors/rmvpe.pt', 'rvc/models/predictors/rmvpe.pt'],
  ['embedders/contentvec/config.json', 'rvc/models/embedders/contentvec/config.json'],
  ['embedders/contentvec/pytorch_model.bin', 'rvc/models/embedders/contentvec/pytorch_model.bin'],
]
// 国内直连 HuggingFace 常常很慢：先试镜像，太慢或卡住再换官方
const HF_HOSTS = ['https://hf-mirror.com', 'https://huggingface.co']

const FETCH_SCRIPT = fileURLToPath(new URL('song/fetch_file.py', globalThis.aurabot.src))

// 自动变调脚本：读干声估中位音高，算出该升/降几个半音
const PITCH_SCRIPT = fileURLToPath(new URL('pitch.py', import.meta.url))
// 母带链：人声激励 → 压缩/混响 → 伴奏跟调 → 混音 → -14 LUFS（移植自 dafish 唱歌包 master.py）
const MASTER_SCRIPT = fileURLToPath(new URL('master.py', import.meta.url))
// 人声探测：判断这一段是不是多声部/和声（那种 RVC 怎么调都唱不了，只能换段）
const PROBE_SCRIPT = fileURLToPath(new URL('probe.py', import.meta.url))

/**
 * 下载一个预训练文件：已经有了就跳过。用翻唱环境里的 Python 下（会走系统代理），
 * 断了从断点接着下，卡住 30 秒就换下一个源，几轮都不行才算失败。
 */
async function downloadWithMirror(python, rel, dest, note, log, onProgress) {
  return fetchFile(python, dest, HF_HOSTS.map((host) => `${host}/IAHispano/Applio/resolve/main/Resources/${rel}`), note, log, onProgress, rel)
}

// uv 的下载源：PyPI 上的 uv 安装包（固定版本，里面带 uv.exe）走国内镜像，最后才试 GitHub。
const UV_WHEEL = 'packages/32/ea/771744a784b16aa21d195cb5d5d5a2878d72fa00fc26f11ea3f9646994fe/uv-0.13.5-py3-none-win_amd64.whl'
export const UV_SOURCES = [
  { url: `https://mirrors.aliyun.com/pypi/${UV_WHEEL}`, sha256: '1fb29fc46ba12033e2ef95a95ac79d649e71bbb1358419bbbcbd19d86026ef2f' },
  { url: `https://files.pythonhosted.org/${UV_WHEEL}`, sha256: '1fb29fc46ba12033e2ef95a95ac79d649e71bbb1358419bbbcbd19d86026ef2f' },
  { url: 'https://github.com/astral-sh/uv/releases/latest/download/uv-x86_64-pc-windows-msvc.zip' },
]

/** 在目录里（含子目录）找一个文件名。 */
function findFile(dir, name) {
  const stack = [dir]
  while (stack.length) {
    const d = stack.pop()
    let names
    try { names = readdirSync(d, { withFileTypes: true }) } catch (error) { continue }
    for (const e of names) {
      const full = join(d, e.name)
      if (e.isDirectory()) stack.push(full)
      else if (e.name.toLowerCase() === name) return full
    }
  }
  return ''
}

/** 默认分离模型的文件都在不在。 */
export function separatorReady(dir, model) {
  const files = SEPARATOR_FILES[model]
  if (!files) return existsSync(join(dir, model))
  return files.every(([name]) => existsSync(join(dir, name)) && statSync(join(dir, name)).size > 0)
}

/** 下载一个文件：已经有了就跳过；地址按顺序轮流试，断了接着下，走系统代理。 */
async function fetchFile(python, dest, urls, note, log, onProgress, label = basename(dest), sha256 = '') {
  const rel = label
  if (existsSync(dest) && statSync(dest).size > 0) return
  // 上次没下完的（.download）会接着下
  const part = dest + '.download'
  note?.(existsSync(part) ? `接着下 ${rel}（上次下到 ${Math.round(statSync(part).size / 1048576)} MB）` : `下载 ${rel}`)
  let lastPct = -1
  await run(python, [FETCH_SCRIPT, ...(sha256 ? ['--sha256', sha256] : []), dest, ...urls], {
    log,
    env: { PYTHONIOENCODING: 'utf-8' },
    timeoutMs: 2 * 3600_000,
    onLine: (line) => {
      const m = line.match(/^progress (\d+) (\d+)/)
      if (m && Number(m[2])) {
        onProgress?.(Number(m[1]), Number(m[2]))
        const pct = Math.floor((Number(m[1]) / Number(m[2])) * 10) * 10
        if (pct !== lastPct) { lastPct = pct; note?.(`  ${rel}：${pct}%`) }
      } else if (/^retry /.test(line)) note?.('  ' + line.replace(/^retry /, '断了，换个源接着下：'))
    },
  })
}

/** 模型文件能不能读：刚下完/导入的大文件常被杀毒软件锁住几秒，等一等再试，还不行就报出是哪个文件。 */
export async function ensureReadable(files, tries = 4, waitMs = 3000) {
  for (const f of files) {
    if (!existsSync(f)) continue
    for (let i = 1; ; i++) {
      try {
        const fd = openSync(f, 'r')
        try { readSync(fd, Buffer.alloc(16), 0, 16, 0) } finally { closeSync(fd) }
        break
      } catch (error) {
        if (i >= tries || !/EACCES|EPERM|EBUSY/.test(error.code || '')) throw new Error(`Permission denied: '${f}'（${error.code || error.message}）`)
        await new Promise((r) => setTimeout(r, waitMs))
      }
    }
  }
}

/** 一个目录（含子目录）有多大，字节。目录不存在算 0。 */
export function dirSize(dir) {
  let total = 0
  const stack = [dir]
  while (stack.length) {
    const d = stack.pop()
    let names
    try { names = readdirSync(d, { withFileTypes: true }) } catch (error) { continue }
    for (const e of names) {
      const full = join(d, e.name)
      if (e.isDirectory()) stack.push(full)
      else try { total += statSync(full).size } catch (error) {}
    }
  }
  return total
}

/** 翻唱环境的根目录：老安装沿用 C:\Aurabot\rvc，新安装放用户目录下。 */
export function defaultRoot() {
  return existsSync(LEGACY_ROOT) ? LEGACY_ROOT : join(homedir(), 'Aurabot', 'rvc')
}

/**
 * 检查安装位置：要绝对路径；中文、空格可能让一些工具出问题，提醒一下；顺便看看那个盘还剩多少空间（装完约 8 GB）。
 * @returns {{ok: boolean, path: string, message: string, warn: string, freeGB: number|null}}
 */
/** 把安装时的报错翻译成人话，并告诉用户接下来怎么办。 */
export function explainInstallError(msg) {
  const m = String(msg || '')
  if (/ENOENT/.test(m)) return `找不到需要的程序（${(m.match(/spawn (\S+)/) || [])[1] || '?'}）。点「重新检查 / 修复安装」再试一次；还不行就把报错发给作者`
  if (/ENOSPC|No space|磁盘空间|not enough space/i.test(m)) return '磁盘空间不够了。换一个空间大的盘（上面「装到哪里」），保存后再装'
  if (/timed? ?out|超时|30 秒没进度|operation timed/i.test(m)) return '网络太慢、超时了。打开「用国内镜像下载」或者开着代理，再点安装（已下好的不会重下）'
  if (/connection|connect|reset|TLS|SSL|dns|resolve|Failed to fetch|Failed to download|error sending request|无法连接|网络/i.test(m)) return '网络连接断了。打开「用国内镜像下载」或者开着代理，再点安装（已下好的不会重下）'
  if (/CUDA|nvidia|GPU/i.test(m)) return '和显卡驱动有关，可能需要更新 NVIDIA 驱动。' + m.slice(0, 160)
  return m.slice(0, 300)
}

/** 安装的几步（面板按这个画步骤条）。 */
export const INSTALL_STEPS = ['创建 Python 环境', '下载 Applio（RVC 推理引擎）', '安装 PyTorch、RVC 和人声分离（最大的一步）', '准备 ffmpeg', '下载 RVC 需要的预训练文件（音高、音色特征）', '下载人声分离模型']

// 默认人声分离模型要的文件：[文件名, 下载地址（按顺序试）, sha256]。提前下好，免得第一次点歌时卡着不动。
// 模型 640 MB，GitHub 在国内经常下不动：先走 HuggingFace 镜像（有人转存了同一个文件，校验值一样），再试官方。
// 下完核对 sha256，哪个源给的文件不对就换下一个；配置文件很小，随插件带着（src/song/separator/）。
const GH_UVR = 'https://github.com/TRvlvr/model_repo/releases/download/all_public_uvr_models'
const GH_AS = 'https://github.com/nomadkaraoke/python-audio-separator/releases/download/model-configs'
const HF_SEP = ['Politrees/UVR_resources/resolve/main/models/Roformer/BandSplit', 'datasets/SayanoAI/RVC-Studio/resolve/main/UVR']
const BS_ROFORMER = 'model_bs_roformer_ep_317_sdr_12.9755'
export const SEPARATOR_FILES = {
  [`${BS_ROFORMER}.ckpt`]: [
    [`${BS_ROFORMER}.ckpt`, [
      ...HF_SEP.map((p) => `https://hf-mirror.com/${p}/${BS_ROFORMER}.ckpt`),
      `${GH_UVR}/${BS_ROFORMER}.ckpt`,
      `https://huggingface.co/${HF_SEP[0]}/${BS_ROFORMER}.ckpt`,
      `${GH_AS}/${BS_ROFORMER}.ckpt`,
    ], '5b84f37e8d444c8cb30c79d77f613a41c05868ff9c9ac6c7049c00aefae115aa'],
    [`${BS_ROFORMER}.yaml`, [`${GH_AS}/${BS_ROFORMER}.yaml`], '2bfdd16c656bd9519aba757cc4f8834b7ede675eb1e00ec4772d74ae1c41af7f'],
  ],
}
const BUNDLED_SEP = fileURLToPath(new URL('song/separator/', globalThis.aurabot.src))

/** 手动下载用的地址（面板里给用户复制，用浏览器或下载工具下好再拖进来）。 */
export function separatorLinks(model) {
  return (SEPARATOR_FILES[model] || []).slice(0, 1).flatMap(([, urls]) => urls.slice(0, 3))
}

/**
 * 导入手动下好的分离模型：核对 sha256，对得上才放进去。
 * @returns {{ok:boolean, message:string}}
 */
export function importSeparator(dir, filename, buf) {
  const sha = createHash('sha256').update(buf).digest('hex')
  for (const files of Object.values(SEPARATOR_FILES)) {
    const hit = files.find(([, , want]) => want === sha)
    if (hit) {
      mkdirSync(dir, { recursive: true })
      writeFileSync(join(dir, hit[0]), buf)
      rmSync(join(dir, hit[0] + '.download'), { force: true })
      return { ok: true, message: `人声分离模型导入好了（${hit[0]}）` }
    }
  }
  return { ok: false, message: `「${filename}」不是插件要的人声分离模型（校验对不上），要下 ${BS_ROFORMER}.ckpt` }
}
// 分离工具每次运行都要的模型清单（缺了会去 raw.githubusercontent.com 拉，国内常常连不上）
const SEPARATOR_LIST = ['download_checks.json', ['https://raw.githubusercontent.com/TRvlvr/application_data/main/filelists/download_checks.json', 'https://cdn.jsdelivr.net/gh/TRvlvr/application_data@main/filelists/download_checks.json']]

/** 电脑上的盘和剩余空间，给面板「装到哪个盘」用：[{drive, root, freeGB, totalGB}] */
export function listDrives() {
  const out = []
  for (const L of 'CDEFGHIJKLMNOPQRSTUVWXYZ') {
    const d = `${L}:\\`
    try {
      if (!existsSync(d)) continue
      const s = statfsSync(d)
      const gb = (n) => Math.round((Number(n) * Number(s.bsize)) / 1024 ** 3 * 10) / 10
      if (!s.blocks) continue
      out.push({ drive: `${L}:`, root: `${L}:\\Aurabot\\rvc`, freeGB: gb(s.bavail), totalGB: gb(s.blocks) })
    } catch (error) {}
  }
  return out
}

export function checkRoot(path) {
  const p = String(path || '').trim()
  if (!p) return { ok: true, path: '', message: '', warn: '', freeGB: null }
  if (!isAbsolute(p) || !/^[A-Za-z]:\\/.test(p.replace(/\//g, '\\'))) return { ok: false, path: p, message: '要写完整路径，比如 D:\\Aurabot\\rvc', warn: '', freeGB: null }
  const warn = /[^\x21-\x7e]/.test(p) ? '路径里有中文或空格，个别工具可能出问题，最好换成全英文、不带空格的路径' : ''
  let freeGB = null
  try {
    // 往上找到第一个存在的目录来量剩余空间
    let probe = p
    while (!existsSync(probe) && dirname(probe) !== probe) probe = dirname(probe)
    const s = statfsSync(probe)
    freeGB = Math.round((Number(s.bavail) * Number(s.bsize)) / 1024 ** 3 * 10) / 10
  } catch (error) {}
  return { ok: true, path: p, message: '', warn: warn || (freeGB !== null && freeGB < 10 ? `这个盘只剩 ${freeGB} GB，装完要 8 GB 左右，安装时还要临时多占几 GB` : ''), freeGB }
}

export function pathsOf(root) {
  return {
    root,
    python: join(root, 'env', 'Scripts', 'python.exe'),
    separatorExe: join(root, 'env', 'Scripts', 'audio-separator.exe'),
    applio: join(root, 'Applio'),
    models: join(root, 'models'),
    separatorModels: join(root, 'separator-models'),
    bin: join(root, 'bin'),
    ffmpeg: join(root, 'bin', 'ffmpeg.exe'),
    rmvpe: join(root, 'Applio', 'rvc', 'models', 'predictors', 'rmvpe.pt'),
    contentvec: join(root, 'Applio', 'rvc', 'models', 'embedders', 'contentvec', 'pytorch_model.bin'),
  }
}

/** models 目录里的音色：[{id, pth, index}]，同名 .index 可选。 */
export function listVoices(modelsDir) {
  let names = []
  try { names = readdirSync(modelsDir) } catch (error) { return [] }
  return names.filter((n) => n.toLowerCase().endsWith('.pth')).sort().map((n) => {
    const id = n.slice(0, -4)
    const idx = names.find((m) => m.toLowerCase().endsWith('.index') && m.toLowerCase().includes(id.toLowerCase()))
    return { id, pth: join(modelsDir, n), index: idx ? join(modelsDir, idx) : '' }
  })
}

/** 像不像 RVC 模型：PyTorch 存的 .pth 要么是 zip 格式（PK 开头），要么是老的 pickle（0x80 开头）。 */
export function looksLikePth(buf) {
  return buf.length > 1024 * 1024 && ((buf[0] === 0x50 && buf[1] === 0x4b) || buf[0] === 0x80)
}

const safeName = (n) => basename(String(n).replace(/\\/g, '/')).replace(/[<>:"|?*\x00-\x1f]/g, '_').trim()

/**
 * 导入音色：.pth / .index，或者装着它们的 zip。存进 models 目录。
 * zip 里只有一个音色时，index 自动改名成「音色名.index」配上。
 * @returns {{ok: boolean, added: string[], indexes: number, message: string}}
 */
export function importModels(modelsDir, filename, buf) {
  const name = safeName(filename)
  const lower = name.toLowerCase()
  let files
  if (lower.endsWith('.zip')) {
    files = readZip(buf, (n) => /\.(pth|index)$/i.test(n) && !n.includes('__MACOSX')).map((f) => ({ name: safeName(f.name), data: f.data }))
  } else if (lower.endsWith('.pth') || lower.endsWith('.index')) {
    files = [{ name, data: buf }]
  } else {
    return { ok: false, added: [], indexes: 0, message: '只支持 .zip、.pth、.index 文件' }
  }
  const pths = files.filter((f) => f.name.toLowerCase().endsWith('.pth'))
  const idxs = files.filter((f) => f.name.toLowerCase().endsWith('.index'))
  if (!pths.length && !idxs.length) return { ok: false, added: [], indexes: 0, message: '里面没找到 .pth 模型' }
  const bad = pths.filter((f) => !looksLikePth(f.data))
  if (bad.length) return { ok: false, added: [], indexes: 0, message: `「${bad[0].name}」看起来不是 RVC 模型` }
  mkdirSync(modelsDir, { recursive: true })
  for (const f of pths) writeFileSync(join(modelsDir, f.name), f.data)
  const solo = pths.length === 1 ? pths[0].name.slice(0, -4) : ''
  for (const f of idxs) writeFileSync(join(modelsDir, solo && idxs.length === 1 ? `${solo}.index` : f.name), f.data)
  const added = pths.map((f) => f.name.slice(0, -4))
  return {
    ok: true,
    added,
    indexes: idxs.length,
    message: added.length ? `导入了 ${added.length} 个音色：${added.join('、')}${idxs.length ? `（带 ${idxs.length} 个 index）` : ''}` : `导入了 ${idxs.length} 个 index`,
  }
}

/** 删掉一个音色（连同配套的 index）。 */
export function deleteVoice(modelsDir, id) {
  const v = listVoices(modelsDir).find((x) => x.id === id)
  if (!v) return { ok: false, message: '没有这个音色' }
  rmSync(v.pth, { force: true })
  if (v.index) rmSync(v.index, { force: true })
  return { ok: true, message: `删掉了「${id}」` }
}

/** 缓存目录只留最新的 keep 个文件。 */
/**
 * 清理成品缓存。keep = 最多留几个；maxGB > 0 时再按总大小兜一层（先删最旧的，直到同时满足两个上限）。
 * 以前只有条数上限（40 条），单条上百 MB 时照样能堆到几个 GB。
 */
export function pruneCache(dir, keep, maxGB = 0) {
  let files = []
  try {
    files = readdirSync(dir).map((n) => {
      const st = statSync(join(dir, n))
      return { n, t: st.mtimeMs, size: st.size }
    })
  } catch (error) { return 0 }
  const sorted = files.sort((a, b) => b.t - a.t)
  const removed = []
  // 1) 先按条数裁
  for (const f of sorted.slice(Math.max(0, keep))) removed.push(f.n)
  // 2) 再按总字节裁（只算保留下来的那些）
  const limitBytes = Math.max(0, Number(maxGB) || 0) * 1024 * 1024 * 1024
  if (limitBytes > 0) {
    const kept = sorted.slice(0, Math.max(0, keep))
    let total = kept.reduce((s, f) => s + (f.size || 0), 0)
    for (let i = kept.length - 1; i >= 0 && total > limitBytes; i--) {
      removed.push(kept[i].n)
      total -= kept[i].size || 0
    }
  }
  for (const n of new Set(removed)) rmSync(join(dir, n), { force: true })
  return new Set(removed).size
}

/** 截一段：歌比上限长时从「大约副歌」的位置开始（全曲 30% 处），否则从头。 */
/** 分出来的人声轨平均音量低于这个就当没有人声。正常人声在 -15 ~ -30 dB，纯音乐分出来是 -80 以下。 */
export const VOCAL_MIN_DB = -50

const INSTRUMENTAL = /纯音乐|伴奏|钢琴|吉他|八音盒|音乐盒|古筝|琵琶|二胡|笛子|葫芦丝|小提琴|大提琴|口琴|萨克斯|instrumental|off ?vocal|karaoke|\binst\b|\bbgm\b|music box|piano/i

// ===== 选歌打分（思路抄自 astrbot-plugin-chorus-cover 的 pick_best_song，重写成 JS）=====
// 原来只把伴奏类挪到最后，其余保持搜索顺序——点上《晴天》可能拿到 DJ 版或翻唱版。
// 这里按匹配度打分，分高的排前面；download() 仍然逐首试着下载，下不动的自然跳过。
const VERSION_WORDS = ['翻唱', 'cover', '深情版', '女声版', '男声版', '童声版', '钢琴版', '吉他版', 'dj版', 'remix', '慢速', '加速', '降调', '升调', '片段', '剪辑', '8d', '抖音', '翻自', '原唱']
/** 归一化：去掉空白、标点、括号，转小写——只留能比对的字。 */
const normTitle = (t) => String(t || '').toLowerCase()
  .replace(/[\s\-_·・.,，。\/\\()（）\[\]【】"'“”‘’!！?？:：;；~～+&]/g, '')
/** 去掉版本后缀：「小幸运 (翻唱)」→「小幸运」。 */
const stripVersion = (name) => {
  let t = String(name || '').replace(/[（(\[【][^）)\]】]*[）)\]】]/g, '')
  for (const w of VERSION_WORDS) t = t.replace(new RegExp(w, 'gi'), '')
  return t
}
/** 只差一个字也算同一首（异体字：千千阙歌 / 千千阕歌）。 */
const oneCharApart = (a, b) => a.length === b.length && a.length >= 3
  && [...a].filter((ch, i) => ch !== b[i]).length <= 1

/**
 * 一首候选的匹配分。分数没有绝对意义，只用来排序。
 * 伴奏类给 -999（永远排最后，除非点歌时本来就要伴奏）。
 */
export function scoreCandidate(song, query) {
  const s = song || {}
  const q = normTitle(query)
  const name = String(s.name || '')
  const both = name + ' ' + String(s.alias || '')
  const nName = normTitle(name)
  const nBoth = normTitle(both)
  const nStrip = normTitle(stripVersion(name))
  const wanted = VERSION_WORDS.filter((w) => q.includes(normTitle(w)))
  if (!INSTRUMENTAL.test(query) && INSTRUMENTAL.test(both)) return -999

  let score = 10
  if (!q) score = 50
  else if (nName === q) score = 100
  else if (nStrip === q) score = 88
  else if (nName.includes(q) && nName.length - q.length <= 12) score = 70
  else if (nBoth.includes(q) && nBoth.length - q.length <= 8) score = 65
  else if (oneCharApart(nName, q)) score = 62
  // 反向包含：「周杰伦 晴天」这种把歌手写在歌名里的说法
  else if (q.includes(nName) && nName.length >= 2) score = 55

  // 用户点名了版本（女声版 / 钢琴版 / live…），命中就抬到 80 —— 他要的就是这个版本
  if (wanted.length && wanted.every((w) => nBoth.includes(normTitle(w)))) score = Math.max(score, 80)

  // 现场版 / DJ 版：用户没点名就不要（原曲优先）。
  // 这里**不含「翻唱」**：翻唱由上面的版本词规则管（没点名就 -45，点名了就抬分）。
  // 混进来会导致「我要翻唱版」反被扣 30 分、选出原版。
  const liveDj = /(?<![a-z])(live|dj|remix|inst)/.test(nBoth)
    || /[（(\[]\s*(dj|remix)/i.test(name)
    || /现场|演唱会|音乐会/.test(name)
  if (liveDj && !wanted.some((w) => ['live', 'dj', 'remix'].includes(normTitle(w)))) score -= 30

  // 没点名版本时，翻唱/改编优先淘汰。「原唱」也算：网易云上「晴天 (原唱 周杰伦)」
  // 往往是别人翻的，标题里写「原唱」只是标注原唱是谁。
  if (!wanted.length && VERSION_WORDS.some((w) => nBoth.includes(normTitle(w)))) score -= 45

  const durMs = (Number(s.durationSec) || 0) * 1000
  if (durMs > 0 && durMs < 60000) score -= 40
  else if (durMs >= 120000) score += 3
  return score
}

/** 搜索结果排序：按匹配分从高到低，同分保持原来的搜索顺序。 */
export function rankCandidates(list, query = '') {
  return (Array.isArray(list) ? list : [])
    .map((s, i) => ({ s, i, score: scoreCandidate(s, query) }))
    .sort((a, b) => b.score - a.score || a.i - b.i)
    .map((x) => x.s)
}

/**
 * 从每秒能量曲线里挑一段最像副歌的。
 * 起点限制在 12%~82%：不选前奏，也不选最后收尾那几句。
 * 返回 null 表示数据不够，调用方回落到原来「30% 处」的截法。
 */
export function pickChorus(rms, durationSec, maxSec) {
  const n = Array.isArray(rms) ? rms.length : 0
  const win = Math.max(1, Math.round(Number(maxSec) || 0))
  if (!n || !win || n < win + 4) return null
  // 3 秒滑动平均，压掉鼓点那种一下一下的尖峰
  const smooth = []
  for (let i = 0; i < n; i++) {
    let sum = 0
    let cnt = 0
    for (let k = Math.max(0, i - 1); k <= Math.min(n - 1, i + 1); k++) { sum += rms[k]; cnt++ }
    smooth.push(sum / cnt)
  }
  const lo = Math.floor(n * 0.12)
  const hi = Math.max(lo, Math.floor(n * 0.82))
  let best = lo
  let bestSum = -1
  for (let s = lo; s <= hi && s + win <= n; s++) {
    let sum = 0
    for (let k = 0; k < win; k++) sum += smooth[s + k]
    if (sum > bestSum) { bestSum = sum; best = s }
  }
  const start = Math.max(0, Math.min(best, Math.floor(Number(durationSec) - maxSec)))
  return { start, length: Math.min(Number(maxSec), Number(durationSec)) }
}

export function clipWindow(durationSec, maxSec, start = 'auto') {
  if (!(durationSec > maxSec)) return { start: 0, length: durationSec }
  if (start === 'head') return { start: 0, length: maxSec }
  const s = Math.max(0, Math.min(Math.round(durationSec * 0.3), Math.floor(durationSec - maxSec)))
  return { start: s, length: maxSec }
}

/**
 * 单步任务的超时（毫秒）：配置 song.taskTimeoutSec 优先，没配就用各自的兜底值。
 * 这里是文件级函数，拿不到 createSongStudio 闭包里的 cfg()，所以用一个在创建时挂上的引用
 * （见 createSongStudio 里的 setStudioCfgGetter）。
 */
let studioCfgGetter = null
function studioCfg() {
  try { return studioCfgGetter ? studioCfgGetter() : null } catch (error) { return null }
}
function taskTimeoutMs(fallback) {
  const sec = Number(studioCfg()?.taskTimeoutSec)
  if (!Number.isFinite(sec) || sec <= 0) return fallback
  return Math.max(60_000, sec * 1000)
}

function run(cmd, args, { cwd, env, log, onLine, timeoutMs = 30 * 60_000 } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, { cwd, env: { ...process.env, ...env }, windowsHide: true })
    let tail = ''
    const feed = (buf) => {
      const s = String(buf)
      tail = (tail + s).slice(-4000)
      for (const line of s.split(/\r?\n|\r/)) if (line.trim()) onLine?.(line.trim())
    }
    child.stdout.on('data', feed)
    child.stderr.on('data', feed)
    const timer = setTimeout(() => { try { child.kill() } catch (error) {} }, timeoutMs)
    child.on('error', (e) => { clearTimeout(timer); reject(e) })
    child.on('exit', (code) => {
      clearTimeout(timer)
      if (code === 0) resolve(tail)
      else {
        log?.debug(`${basename(cmd)} 失败（code ${code}）：${tail.slice(-800)}`)
        reject(new Error(`${basename(cmd)} 退出码 ${code}：${tail.trim().split(/\r?\n/).slice(-2).join(' ').slice(0, 300)}`))
      }
    })
  })
}

/**
 * @param {object} deps
 * @param {() => object} deps.getConfig
 * @param {object} deps.log
 * @param {(chatId: string, file: string, note: string) => Promise<any>} deps.sendVoiceFile  把做好的语音发到聊天
 * @param {(chatId: string, text: string) => Promise<any>} [deps.sendText]
 */
/** 翻唱出错翻译成人话（给点歌的人看）。 */
export function explainSongError(message) {
  const m = String(message || '')
  if (/size mismatch|Error\(s\) in loading state_dict|unexpected key|Missing key|KeyError: '(weight|config|params)'/i.test(m)) return '这个音色模型和内置的 RVC 不兼容（可能是 so-vits-svc 之类训练的，或者不是完整的模型文件）。可以在面板「本地接口」里接你自己的推理'
  if (/CUDA out of memory|OutOfMemoryError|not enough memory/i.test(m)) return '显卡显存不够，关掉别的占显存的程序（游戏、别的 AI）再试'
  if (/No module named|ModuleNotFoundError/i.test(m)) return '翻唱环境不完整，在面板「翻唱」页点「重新检查 / 修复安装」'
  if (/Permission denied|Errno 13|EACCES|EPERM|EBUSY/i.test(m)) {
    const file = (m.match(/'([^']+\.(?:ckpt|pth|onnx|yaml|json))'/i) || [])[1]?.replace(/\\\\/g, '\\')
    return `${file ? `读不了「${file}」` : '有个模型文件读不了'}：多半是杀毒软件（360、火绒、Defender）正在扫描或拦住了它，或者文件是用管理员身份放进去的。把翻唱目录加进杀毒软件的信任区再试；还不行就删掉这个文件，在面板「翻唱」页重新下载`
  }
  return m
}

/**
 * 取源顺序：默认 B 站优先；面板开了「优先用网易云」就反过来。
 * 只是顺序，成不成都由具体的下载函数说了算（失败自动换下一个源）。
 */
export function sourceOrder(neteaseFirst) {
  return neteaseFirst === true ? ['netease', 'bili'] : ['bili', 'netease']
}

export function createSongStudio({ getConfig, log, sendVoiceFile, sendText, onSung, onSettled, local }) {
  const cfg = () => getConfig().song
  // 给文件级的 taskTimeoutMs 挂上配置读取（同一时刻只有一个 studio 实例）
  studioCfgGetter = () => getConfig().song
  const P = () => pathsOf(cfg().root || defaultRoot())
  const work = () => dataDir('songs')
  // 确认过没有人声的歌（网易云 id），下次直接跳过，不用再花几分钟分离一遍
  const noVocalFile = () => join(work(), 'no-vocals.json')
  const noVocals = () => readJson(noVocalFile(), () => [])
  const markNoVocals = (id) => { if (id && !noVocals().includes(String(id))) writeJson(noVocalFile(), [...noVocals(), String(id)].slice(-500)) }
  const queue = []
  let current = null // 正在做的翻唱
  let history = [] // 最近做过的 [{at, title, voice, ok, message, file}]
  let install = { running: false, step: '', log: [], ok: null, message: '' }

  function status() {
    const p = P()
    const voices = listVoices(p.models)
    const parts = {
      python: existsSync(p.python),
      applio: existsSync(join(p.applio, 'core.py')),
      separator: existsSync(p.separatorExe),
      ffmpeg: existsSync(p.ffmpeg),
      weights: existsSync(p.rmvpe) && existsSync(p.contentvec),
      separatorModel: separatorReady(p.separatorModels, cfg().separatorModel),
    }
    // 换声交给本地脚本时，不需要内置的 Applio / 预训练文件 / 音色模型（下载、分离、混音还是插件做）
    const localSong = Boolean(local?.active('song'))
    const ready = localSong ? ['python', 'separator', 'ffmpeg', 'separatorModel'].every((k) => parts[k]) : Object.values(parts).every(Boolean) && voices.length > 0
    return {
      enabled: cfg().enabled,
      ready,
      root: p.root,
      defaultRoot: defaultRoot(),
      rootCheck: checkRoot(p.root),
      pypiMirror: cfg().pypiMirror || 'auto',
      parts,
      voices: voices.map((v) => ({ id: v.id, hasIndex: Boolean(v.index) })),
      separatorLinks: parts.separatorModel ? [] : separatorLinks(cfg().separatorModel),
      voice: cfg().voice,
      install: { ...install, log: install.log.slice(-30) },
      current: current ? { ...current } : null,
      queue: queue.map((q) => ({ query: q.query, chatId: q.chatId })),
      history: history.slice(0, 10),
      message: !voices.length ? '还没有音色：在下面「音色模型」里导入你有权使用的 RVC 模型（.pth 或 zip）' : ready ? (cfg().enabled ? '可以点歌了' : '准备好了，打开开关就能用') : '还差一些组件，点「一键安装」',
    }
  }

  // ---------- 一键安装（几个 GB，要十几分钟）----------
  async function runInstall() {
    if (install.running) return { ok: false, message: '已经在装了' }
    const p = P()
    install = { running: true, step: '', stepIndex: -1, steps: INSTALL_STEPS, stepHint: '', stepAt: 0, startedAt: Date.now(), progress: null, log: [], ok: null, message: '' }
    const note = (s) => { install.log.push(s); if (install.log.length > 200) install.log.shift() }
    const step = async (name, hint, fn) => {
      Object.assign(install, { step: name, stepIndex: INSTALL_STEPS.indexOf(name), stepHint: hint, stepAt: Date.now(), progress: null })
      note('▶ ' + name)
      log.info('翻唱安装：' + name)
      await fn()
    }
    // 这次安装的下载缓存放在安装目录里：一来能统计下载了多少（给面板看进度），二来装完删掉不占地方
    const cacheDir = join(p.root, 'uv-cache')
    const cn = await shouldUseCnMirror(cfg().pypiMirror)
    if (cn) note(cfg().pypiMirror === 'cn' ? '用国内镜像下载' : '官方源连得慢，自动改用国内镜像下载')
    const uvEnv = {
      UV_CACHE_DIR: cacheDir,
      UV_HTTP_TIMEOUT: '300',
      UV_HTTP_RETRIES: '6',
      UV_PYTHON_INSTALL_DIR: join(p.root, 'python'), // Python 也装在选的位置里，不偷偷占 C 盘
      ...(cn ? { UV_PYTHON_INSTALL_MIRROR: CN_PYTHON } : {}),
    }
    const mirror = cn ? ['--default-index', CN_PYPI] : []
    let uv = 'uv'
    try {
      mkdirSync(p.root, { recursive: true })
      mkdirSync(p.models, { recursive: true })
      await step('创建 Python 环境', '第一次要下载 Python 3.12（约 30 MB）和安装工具，一般 1~3 分钟', async () => {
        uv = await ensureUv(note)
        if (existsSync(p.python)) return note('  已经有了，跳过')
        const stop = watchDownload(join(p.root, 'python'))
        try {
          await run(uv, ['venv', '-q', join(p.root, 'env'), '--python', '3.12'], { log, onLine: note, env: uvEnv, timeoutMs: 30 * 60_000 })
        } finally {
          stop()
        }
      })
      await step('下载 Applio（RVC 推理引擎）', '要下载几十 MB，一般 1~3 分钟', async () => {
        if (existsSync(join(p.applio, 'core.py'))) return note('  已经有了，跳过')
        // 直接下代码压缩包（固定版本），不需要电脑上装 git
        const zip = join(p.root, 'downloads', 'applio.zip')
        // 用环境里的 Python 下（断了能接着下、走系统代理）；万一不行再用 PowerShell 下
        try {
          await fetchFile(p.python, zip, [`https://github.com/IAHispano/Applio/archive/${APPLIO_COMMIT}.zip`, `https://codeload.github.com/IAHispano/Applio/zip/${APPLIO_COMMIT}`], note, log, (done, total) => {
            install.progress = { kind: 'file', name: 'Applio', done, total }
          })
        } catch (error) {
          note('  换个方式再下一次')
          await fetchWithProgress(`https://github.com/IAHispano/Applio/archive/${APPLIO_COMMIT}.zip`, zip)
        }
        const tmp = join(p.root, 'downloads', 'applio-src')
        rmSync(tmp, { recursive: true, force: true })
        await expandZip(zip, tmp)
        const inner = readdirSync(tmp).find((n) => existsSync(join(tmp, n, 'core.py')))
        if (!inner) throw new Error('下载的 Applio 压缩包不完整')
        rmSync(p.applio, { recursive: true, force: true })
        renameSync(join(tmp, inner), p.applio)
        rmSync(join(p.root, 'downloads'), { recursive: true, force: true })
      })
      await step('安装 PyTorch、RVC 和人声分离（最大的一步）', '要下载约 3~4 GB，看网速一般 10~40 分钟；下面的「已下载」在涨就说明没卡住', async () => {
        const stop = watchDownload(cacheDir)
        try {
          await run(uv, ['pip', 'install', '--python', p.python, '-r', join(p.applio, 'requirements-engine.txt'), 'audio-separator[gpu]', 'imageio-ffmpeg',
            ...mirror, ...(cn ? ['--find-links', CN_TORCH] : ['--extra-index-url', TORCH_INDEX]), '--index-strategy', 'unsafe-best-match'], { log, onLine: note, env: uvEnv, timeoutMs: 120 * 60_000 })
        } finally {
          stop()
        }
      })
      await step('准备 ffmpeg', '几秒钟', async () => setupFfmpeg())
      await step('下载 RVC 需要的预训练文件（音高、音色特征）', '约 560 MB，看网速几分钟', async () => {
        for (const [rel, dest] of PREREQS) {
          await downloadWithMirror(p.python, rel, join(p.applio, dest), note, log, (done, total) => {
            install.progress = { kind: 'file', name: rel.split('/').pop(), done, total }
          })
        }
      })
      await step('下载人声分离模型', '约 640 MB，看网速几分钟；下好以后第一次点歌就不用再等', async () => {
        // 配置文件插件自带，先放进去
        mkdirSync(p.separatorModels, { recursive: true })
        for (const n of readdirSync(BUNDLED_SEP)) if (!existsSync(join(p.separatorModels, n))) copyFileSync(join(BUNDLED_SEP, n), join(p.separatorModels, n))
        const files = [...(SEPARATOR_FILES[cfg().separatorModel] || []), SEPARATOR_LIST]
        for (const [name, urls, sha] of files) {
          await fetchFile(p.python, join(p.separatorModels, name), urls, note, log, (done, total) => {
            install.progress = { kind: 'file', name, done, total }
          }, name, sha || '')
        }
      })
      // 下载缓存用完删掉（几个 GB）；环境里的文件是硬链接 / 复制过去的，删缓存不影响
      try { rmSync(cacheDir, { recursive: true, force: true }) } catch (error) {}
      install = { ...install, running: false, ok: true, step: '', progress: null, message: `装好了，用时 ${Math.round((Date.now() - install.startedAt) / 60000)} 分钟` }
      log.info('翻唱环境装好了')
    } catch (error) {
      install = { ...install, running: false, ok: false, progress: null, message: `「${install.step}」这步失败了：${explainInstallError(error.message)}`, error: String(error.message).slice(0, 2000) }
      log.warn('翻唱安装失败：', install.message)
    }
    return { ok: install.ok, message: install.message }
  }

  /**
   * 用 PowerShell 下载一个文件（会走系统代理，不依赖电脑上装了别的工具），下载中显示已下载多少、网速。
   */
  async function fetchWithProgress(url, dest, timeoutSec = 600) {
    mkdirSync(dirname(dest), { recursive: true })
    rmSync(dest, { force: true })
    const stop = watchDownload(dirname(dest))
    try {
      await run('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command',
        "$ProgressPreference='SilentlyContinue'; [Net.ServicePointManager]::SecurityProtocol=[Net.SecurityProtocolType]::Tls12; Invoke-WebRequest -Uri $env:AB_URL -OutFile $env:AB_OUT -UseBasicParsing -TimeoutSec $env:AB_TIMEOUT"],
      { log, env: { AB_URL: url, AB_OUT: dest, AB_TIMEOUT: String(timeoutSec) }, timeoutMs: (timeoutSec + 60) * 1000 })
    } finally {
      stop()
    }
    if (!existsSync(dest) || !statSync(dest).size) throw new Error('下载失败：' + url)
  }

  /** 解压 zip（用 Windows 自带的 Expand-Archive）。 */
  async function expandZip(zip, dir) {
    mkdirSync(dir, { recursive: true })
    await run('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', 'Expand-Archive -LiteralPath $env:AB_ZIP -DestinationPath $env:AB_DIR -Force'],
      { log, env: { AB_ZIP: zip, AB_DIR: dir }, timeoutMs: 10 * 60_000 })
  }

  /** 准备 uv（装 Python 和各种包的工具）：电脑上有就用，没有就下一个放进安装目录。 */
  async function ensureUv(note) {
    if (process.env.AURABOT_UV) return process.env.AURABOT_UV
    const p = P()
    const local = join(p.bin, 'uv.exe')
    if (existsSync(local)) return local
    try {
      await run('uv', ['--version'], { log, timeoutMs: 15_000 })
      return 'uv'
    } catch (error) {}
    note('  电脑上没有 uv，下载一个放进安装目录')
    const zip = join(p.root, 'downloads', 'uv.zip')
    const tmp = join(p.root, 'downloads', 'uv')
    let lastError = null
    for (const src of UV_SOURCES) {
      try {
        await fetchWithProgress(src.url, zip, 5 * 60)
        if (src.sha256 && createHash('sha256').update(readFileSync(zip)).digest('hex') !== src.sha256) throw new Error('下载的文件校验对不上')
        rmSync(tmp, { recursive: true, force: true })
        await expandZip(zip, tmp)
        const exe = findFile(tmp, 'uv.exe')
        if (!exe) throw new Error('里面没找到 uv.exe')
        mkdirSync(p.bin, { recursive: true })
        copyFileSync(exe, local)
        rmSync(join(p.root, 'downloads'), { recursive: true, force: true })
        return local
      } catch (error) {
        lastError = error
        note(`  从 ${new URL(src.url).host} 下 uv 没成功（${error.message.slice(0, 80)}），换一个源`)
      }
    }
    throw new Error('uv 下载失败：' + (lastError?.message || ''))
  }

  /** 每 4 秒统计一次下载缓存有多大，算出已下载多少、网速多少，给面板看。返回停止函数。 */
  function watchDownload(dir) {
    let last = { at: Date.now(), bytes: dirSize(dir) }
    const base = last.bytes
    const t = setInterval(() => {
      const bytes = dirSize(dir)
      const now = Date.now()
      const speed = Math.max(0, (bytes - last.bytes) / ((now - last.at) / 1000))
      install.progress = { kind: 'download', done: bytes - base, speed }
      last = { at: now, bytes }
    }, 4000)
    t.unref?.()
    return () => clearInterval(t)
  }

  /** 把 imageio-ffmpeg 带的 ffmpeg 复制成 bin\ffmpeg.exe（人声分离要在 PATH 里找到 ffmpeg）。 */
  async function setupFfmpeg() {
    const p = P()
    if (existsSync(p.ffmpeg)) return
    const out = await run(p.python, ['-c', 'import imageio_ffmpeg;print(imageio_ffmpeg.get_ffmpeg_exe())'], { log })
    const src = out.trim().split(/\r?\n/).pop()
    mkdirSync(p.bin, { recursive: true })
    copyFileSync(src, p.ffmpeg)
  }

  // ---------- 做一首 ----------
  const pyEnv = () => {
    const p = P()
    return { PATH: p.bin + ';' + process.env.PATH, PYTHONIOENCODING: 'utf-8', PYTHONUTF8: '1' }
  }

  async function ffprobeDuration(file) {
    // ffmpeg -i 会把时长打在 stderr 里，退出码是 1，这里自己接
    return new Promise((resolve) => {
      const c = spawn(P().ffmpeg, ['-hide_banner', '-i', file], { windowsHide: true })
      let s = ''
      c.stderr.on('data', (b) => { s += b })
      c.on('exit', () => {
        const m = s.match(/Duration:\s*(\d+):(\d+):(\d+(?:\.\d+)?)/)
        resolve(m ? Number(m[1]) * 3600 + Number(m[2]) * 60 + Number(m[3]) : 0)
      })
      c.on('error', () => resolve(0))
    })
  }

  /** 人声轨的平均音量（dB）；纯音乐分出来的人声几乎是静音。 */
  async function meanVolume(file) {
    return new Promise((resolve) => {
      const c = spawn(P().ffmpeg, ['-hide_banner', '-i', file, '-af', 'volumedetect', '-f', 'null', '-'], { windowsHide: true })
      let s = ''
      c.stderr.on('data', (b) => { s += b })
      c.on('exit', () => { const m = s.match(/mean_volume:\s*(-?[\d.]+|-inf)/); resolve(m ? (m[1] === '-inf' ? -200 : Number(m[1])) : 0) })
      c.on('error', () => resolve(0))
    })
  }

  /**
   * 音源顺序：默认先 B 站（官方/搬运齐全，没网易云会员也能下），失败再走网易云；
   * 面板上开了「优先用网易云」就反过来。点了具体网易云 id（job.songId）时另算，永远走网易云。
   */
  async function download(job, dir) {
    const c = cfg()
    if (job.songId) return downloadFromNetease(job, dir, c)

    const errs = {}
    for (const src of sourceOrder(c.neteaseFirst)) {
      try {
        if (src === 'netease') return await downloadFromNetease(job, dir, c)
        const hit = await downloadBiliSong(job.query, {
          outFile: join(dir, 'song.mp3'),
          ffmpeg: P().ffmpeg,
          cookie: String((getConfig().bili || {}).cookie || ''),
          log,
        })
        job.title = hit.author ? `${hit.title} - ${hit.author}` : hit.title
        job.songKey = `bili:${hit.bvid}:${hit.cid}`
        return join(dir, 'song.mp3')
      } catch (error) {
        errs[src] = error
        log.warn(`[翻唱] ${src === 'bili' ? 'B 站' : '网易云'}没下成「${job.query}」，换另一个源：${error.message}`)
      }
    }

    throw new Error(`「${job.query}」B 站、网易云都没下到（B 站：${errs.bili && errs.bili.message}；网易云：${errs.netease && errs.netease.message}）`)
  }

  async function downloadFromNetease(job, dir, c) {
    if (job.songId && noVocals().includes(String(job.songId))) throw new Error('这首没有人声（像是纯音乐或伴奏版），换一首吧')
    let pick = job.songId ? { id: job.songId, name: job.query, artists: '' } : null
    if (!pick) {
      const found = await searchSongs(job.query, { cookie: c.neteaseCookie, limit: 10 })
      if (!found.length) throw new Error(`网易云上没搜到「${job.query}」`)
      // 试过、确认没人声的跳过；看着像纯音乐的排到最后
      const known = noVocals()
      const list = rankCandidates(found, job.query).filter((s) => !(job.skip || []).includes(String(s.id)) && !known.includes(String(s.id)))
      if (!list.length) throw new Error(`搜到的「${job.query}」都是没有人声的版本`)
      // 按顺序找第一首拿得到完整音频的
      for (const s of list) {
        const u = await songUrl(s.id, { cookie: c.neteaseCookie })
        if (u.url && !u.trial) { pick = { ...s, url: u.url }; break }
      }
      if (!pick) throw new Error(`「${job.query}」要会员或者有版权限制，下载不了${c.neteaseCookie ? '' : '（在面板里填网易云 Cookie 后可以下会员歌）'}`)
    } else {
      const u = await songUrl(pick.id, { cookie: c.neteaseCookie })
      if (!u.url || u.trial) throw new Error('这首歌下载不了（要会员或者有版权限制）')
      pick.url = u.url
    }
    job.title = pick.artists ? `${pick.name} - ${pick.artists}` : pick.name
    job.songKey = String(pick.id)
    const r = await fetch(pick.url, { signal: AbortSignal.timeout(120_000) })
    if (!r.ok) throw new Error(`下载失败（HTTP ${r.status}）`)
    const buf = Buffer.from(await r.arrayBuffer())
    if (buf.length > 60 * 1024 * 1024) throw new Error('歌太大了')
    const file = join(dir, 'song.mp3')
    writeFileSync(file, buf)
    return file
  }

  async function separate(input, dir) {
    const p = P()
    mkdirSync(p.separatorModels, { recursive: true })
    const model = cfg().separatorModel
    await ensureReadable((SEPARATOR_FILES[model] || [[model]]).map(([n]) => join(p.separatorModels, n)))
    await run(p.separatorExe, [input, '--model_filename', model, '--model_file_dir', p.separatorModels, '--output_dir', dir, '--output_format', 'WAV'], { log, env: pyEnv(), timeoutMs: taskTimeoutMs(20 * 60_000) })
    const files = readdirSync(dir)
    const vocals = files.find((f) => /\(vocals\)/i.test(f))
    const inst = files.find((f) => /\(instrumental\)/i.test(f) || /\(other\)/i.test(f))
    if (!vocals || !inst) throw new Error('人声分离没产出文件')
    return { vocals: join(dir, vocals), inst: join(dir, inst) }
  }

  // Applio 这个版本 pipeline 只实现了 rmvpe / crepe / fcpe；
  // hybrid 在 CLI 里能填但 get_f0 没有分支，会 UnboundLocalError（f0 未赋值）。
  const F0_METHODS = ['rmvpe', 'crepe', 'fcpe']

  /**
   * FAISS 在 Windows 上打不开中文路径：把音色/索引硬链接成纯 ASCII 名字再交给 Applio。
   * 不这样做时 .pth 能加载、但 .index 会被静默跳过，indexRate 等于没设。
   */
  const asciiCache = new Map()
  function asciiAsset(file, ext) {
    if (!file) return ''
    const key = file + '|' + ext
    if (asciiCache.has(key)) return asciiCache.get(key)
    const dir = join(P().models, '.ascii')
    try { mkdirSync(dir, { recursive: true }) } catch (error) {}
    let name
    try {
      const st = statSync(file)
      name = createHash('md5').update(`${resolve(file)}|${st.size}|${Math.round(st.mtimeMs)}`).digest('hex').slice(0, 12) + ext
    } catch (error) { return file }
    const dst = join(dir, name)
    if (!existsSync(dst)) {
      try { linkSync(file, dst) } catch (error) {
        try { copyFileSync(file, dst) } catch (err2) { return file }
      }
    }
    asciiCache.set(key, dst)
    return dst
  }

  /** 自动变调：把干声中位音高夹到 270~320Hz（模型舒适区）。
   *  pitch 写死 0 时，男声歌会让女声模型压着男声的调硬唱，听感就是烟嗓；
   *  高音歌又容易破。这里按干声实际音高算一个 shift，替代配置里的 pitch。 */
  async function detectPitch(file) {
    try {
      const p = P()
      const out = await run(p.python, [PITCH_SCRIPT, file], { log, env: pyEnv(), timeoutMs: taskTimeoutMs(120_000) })
      const line = String(out || '').trim().split(/\r?\n/).pop().trim()
      const nums = line.split(/\s+/).map(Number)
      if (!Number.isFinite(nums[0])) return null
      return { shift: nums[0], median: nums[1] || 0, p95: nums[2] || 0 }
    } catch (error) {
      log.warn('自动变调没算出来，这次用配置里的 pitch：' + (error.message || error))
      return null
    }
  }

  /** 判断这段人声是不是多声部/和声——那种分离出来几条人声叠在一起，RVC 只能跟一条，
   *  其余全变成糊音，参数怎么调都没用，只能换一段独唱。
   *  判据（见 probe.py）：F0 跨度 > 16 半音 且 置信中位 < 0.10。
   *  任何一步失败都返回 null，绝不影响能不能唱。 */
  async function probeVocal(file) {
    try {
      const out = await run(P().python, [PROBE_SCRIPT, file], { log, env: pyEnv(), timeoutMs: 90_000 })
      const line = String(out || '').trim().split(/\r?\n/).reverse().find((s) => s.trim().startsWith('{'))
      if (!line) return null
      const j = JSON.parse(line)
      return j && j.ok ? j : null
    } catch (error) {
      log.warn('人声探测没跑成（不影响唱歌）：' + (error.message || error))
      return null
    }
  }

  async function convert(vocals, dir, voice, pitch) {
    const p = P()
    const out = join(dir, 'vocals_rvc.wav')
    if (local?.active('song')) {
      const { fileOf } = await Promise.resolve(__lib('local/local.js'))
      const r = await local.call('song', { input: vocals, output: out, pitch, voice: voice?.id || '', voiceFile: voice?.pth || '', indexFile: voice?.index || '' })
      const file = fileOf(r) || out
      if (!existsSync(file)) throw new Error('本地换声脚本没写出文件：' + file)
      return file
    }
    // RVC 参数从 song 配置读（面板 / config.json 都能改）；越界一律夹回安全区间
    const sc = cfg()
    const pickNum = (v, dft, lo, hi) => { const n = Number(v); return Number.isFinite(n) ? Math.max(lo, Math.min(hi, n)) : dft }
    const indexRate = voice.index ? pickNum(sc.indexRate, 0.55, 0, 1) : 0
    const protect = pickNum(sc.protect, 0.35, 0, 0.5)
    const volumeEnvelope = pickNum(sc.volumeEnvelope, 0.7, 0, 1)
    const f0Method = F0_METHODS.includes(sc.f0Method) ? sc.f0Method : 'rmvpe'
    const pth = asciiAsset(voice.pth, '.pth')
    const idx = voice.index ? asciiAsset(voice.index, '.index') : ''
    await run(p.python, ['core.py', 'infer', '--input-path', vocals, '--output-path', out, '--pth-path', pth, '--index-path', idx,
      '--pitch', String(pitch), '--index-rate', String(indexRate), '--protect', String(protect), '--f0-method', f0Method,
      '--volume-envelope', String(volumeEnvelope), '--export-format', 'WAV'],
    { cwd: p.applio, log, env: pyEnv(), timeoutMs: taskTimeoutMs(20 * 60_000) })
    if (!existsSync(out)) throw new Error('变声没产出文件')
    return out
  }

  /** 伴奏跟调：人声被 RVC 移了 pitch 个半音，伴奏不移就和人声跑调整个大二度。
   *  asetrate 改音高+速度、atempo 改回速度（保时长）。倍率必须按真实采样率算——
   *  写死 44100 对非 44.1k 的伴奏会移错音程（dafish 实测踩过的坑）。 */
  async function shiftInst(inst, dir, pitch) {
    const n = Number(pitch) || 0
    if (!n) return inst
    const sr = await new Promise((resolve) => {
      const c = spawn(P().ffmpeg, ['-hide_banner', '-i', inst], { windowsHide: true })
      let s = ''
      c.stderr.on('data', (b) => { s += b })
      c.on('exit', () => { const m = s.match(/Audio:.*?, (\d+) Hz/); resolve(m ? Number(m[1]) : 0) })
      c.on('error', () => resolve(0))
    })
    const r = Math.pow(2, n / 12)
    const out = join(dir, 'inst_shifted.wav')
    await run(P().ffmpeg, ['-y', '-hide_banner', '-loglevel', 'error', '-i', inst,
      '-af', `asetrate=${sr || 44100}*${r.toFixed(6)},atempo=${(1 / r).toFixed(6)},aresample=44100`, out], { log })
    return out
  }

  async function mix(vocals, inst, dir, pitch = 0) {
    const c = cfg()
    const full = join(dir, 'cover.mp3')
    const vol = Math.max(0.2, Math.min(2, Number(c.vocalVolume) || 1))
    // ★ Number(0) || 0.8 === 0.8 —— 用 || 兜底会把「清唱（0）」当成没填、直接补成 0.8。
    //   所以这里必须显式判 NaN，而不是靠 falsy。下面 masterMix 同理。
    const ivRaw = Number(c.instVolume)
    const iv = Math.max(0, Math.min(2, Number.isFinite(ivRaw) ? ivRaw : 0.8))
    if (iv <= 0) {
      // 清唱：不掺伴奏，那也没必要做伴奏跟调（省一次整曲解码 + 移调）
      await run(P().ffmpeg, ['-y', '-hide_banner', '-loglevel', 'error', '-i', vocals,
        '-af', `volume=${vol},alimiter=limit=0.95`, '-ac', '2', '-ar', '44100', '-b:a', '192k', full], { log })
      return full
    }
    const instIn = await shiftInst(inst, dir, pitch)
    await run(P().ffmpeg, ['-y', '-hide_banner', '-loglevel', 'error', '-i', vocals, '-i', instIn, '-filter_complex',
      `[0:a]volume=${vol}[v];[1:a]volume=${iv}[i];[v][i]amix=inputs=2:duration=longest:normalize=0,alimiter=limit=0.95`, '-ac', '2', '-ar', '44100', '-b:a', '192k', full], { log })
    return full
  }

  /** 母带链（song.master !== false 时启用）：python master.py 做激励、压缩/混响、
   *  伴奏跟调、-14 LUFS 响度标准化，听感和响度一致性都比直混好（dafish 实测参数）。
   *  任何一步失败自动回落 ffmpeg 直混（mix 自带伴奏跟调），保证唱的功能不受影响。 */
  async function masterMix(vocals, inst, dir, pitch) {
    if (cfg().master === false) return mix(vocals, inst, dir, pitch)
    const out = join(dir, 'cover.mp3')
    const args = [MASTER_SCRIPT, vocals, inst, out, String(Number(pitch) || 0)]
    const rv = Number(cfg().masterReverb)
    if (Number.isFinite(rv) && rv > 0 && rv < 1) args.push('--reverb', String(rv))
    // 面板的两个音量旋钮接进母带链：相对比例由这里定，-14 LUFS 只整体抬降不改比例
    const vv = Math.max(0.2, Math.min(2, Number(cfg().vocalVolume) || 1))
    // 同上：不能用 || 兜底，否则清唱的 0 会被补成 0.8
    const ivRaw2 = Number(cfg().instVolume)
    const iv = Math.max(0, Math.min(2, Number.isFinite(ivRaw2) ? ivRaw2 : 0.8))
    args.push('--vol', String(vv), '--inst-vol', String(iv))
    // 激励强度 / 混音临场高架：不填就用 master.py 里的实测默认（1.0 / 3.0 dB）。
    // 这两个值以前写死，实测 6 kHz 被抬 +12.5 dB、人声频谱质心涨 59%，听感发尖，
    // 所以必须能在不重新装环境的前提下调。
    const ex = Number(cfg().masterExcite)
    if (Number.isFinite(ex) && ex >= 0) args.push('--excite', String(Math.min(1.5, ex)))
    const pr = Number(cfg().masterPresence)
    if (Number.isFinite(pr) && pr >= 0) args.push('--presence', String(Math.min(8, pr)))
    try {
      await run(P().python, args, { cwd: dir, log, env: { ...pyEnv(), SING_FFMPEG: P().ffmpeg }, timeoutMs: 10 * 60_000 })
      if (!existsSync(out)) throw new Error('母带链没产出文件')
      return out
    } catch (error) {
      log.warn('母带链失败，回落直混：' + (error.message || error))
      return mix(vocals, inst, dir, pitch)
    }
  }

  /**
   * 副歌定位：解码成 8k 单声道、带通 200–4000Hz（人声主要频段），按秒算 RMS 再挑窗口。
   * 比原来「固定 30% 处」准得多，代价是多花一两秒解码整曲。
   * 任何一步失败都回落到 clipWindow，不影响能不能唱。
   */
  async function chorusWindow(file, durationSec, maxSec) {
    if (!(durationSec > maxSec)) return { start: 0, length: durationSec }
    const rms = await new Promise((resolve) => {
      let child
      try {
        child = spawn(P().ffmpeg, ['-hide_banner', '-loglevel', 'error', '-i', file,
          '-af', 'highpass=f=200,lowpass=f=4000', '-ac', '1', '-ar', '8000', '-f', 's16le', '-'], { windowsHide: true })
      } catch (error) { resolve([]); return }
      const parts = []
      let done = false
      const finish = (v) => { if (!done) { done = true; resolve(v) } }
      child.stdout.on('data', (b) => parts.push(b))
      child.on('error', () => finish([]))
      child.on('exit', () => {
        try {
          const buf = Buffer.concat(parts)
          const per = 8000
          const n = Math.floor(buf.length / 2 / per)
          const out = []
          for (let sec = 0; sec < n; sec++) {
            let sum = 0
            const base = sec * per * 2
            for (let i = 0; i < per; i++) { const v = buf.readInt16LE(base + i * 2) / 32768; sum += v * v }
            out.push(Math.sqrt(sum / per))
          }
          finish(out)
        } catch (error) { finish([]) }
      })
      setTimeout(() => { try { child.kill() } catch (error) {} finish([]) }, 60_000)
    })
    const w = pickChorus(rms, durationSec, maxSec)
    if (w) {
      log.debug(`翻唱：副歌定位 ${w.start}s~${w.start + w.length}s（共 ${durationSec}s）`)
      return w
    }
    return clipWindow(durationSec, maxSec, 'auto')
  }

  /** 先截出要发的那一段再处理：分离和换声都只算这一段，快一倍多。返回 {file, cut, length}。
   *  startSec 有值时按用户指定的秒数截，不再猜副歌 —— 像《波西米亚狂想曲》这种，
   *  自动定位会挑中能量最大的歌剧段（多声部合唱），换声根本没法听。 */
  async function cutFirst(song, dir, startSec) {
    const c = cfg()
    const dur = await ffprobeDuration(song)
    const maxSec = Number(c.maxVoiceSec) || 120
    // 注意 Number(null) === 0 且 isFinite(0) 为真 —— 不显式挡掉 null 的话，
    // 「没指定位置」会被当成「从第 0 秒开始」，于是永远截前 30 秒（前奏/钢琴段）。
    const forced = (startSec == null || startSec === '') ? NaN : Number(startSec)
    let w
    if (Number.isFinite(forced) && forced >= 0 && dur > 0) {
      const s = Math.max(0, Math.min(forced, Math.max(0, dur - maxSec)))
      w = { start: s, length: Math.min(maxSec, Math.max(0, dur - s)) }
      log.info(`翻唱：按指定位置截取 ${w.start}s~${(w.start + w.length).toFixed(1)}s（全曲 ${dur.toFixed(1)}s）`)
    } else if (c.clipStart === 'head') {
      w = clipWindow(dur, maxSec, 'head')
    } else {
      w = await chorusWindow(song, dur, maxSec)
    }
    if (!dur || (w.start === 0 && w.length >= dur)) return { file: song, cut: false, length: dur, start: 0, auto: false }
    const out = join(dir, 'part.wav')
    await run(P().ffmpeg, ['-y', '-hide_banner', '-loglevel', 'error', '-ss', String(w.start), '-t', String(w.length), '-i', song, '-ar', '44100', out], { log })
    // auto = 这段是机器挑的（不是用户指定、也不是「从头开始」），只有这种才值得质疑
    return { file: out, cut: true, length: w.length, start: w.start, auto: !Number.isFinite(forced) && c.clipStart !== 'head' }
  }

  /** 截过的段落首尾加淡入淡出，听起来不突兀。 */
  async function fade(mixed, dir, length) {
    const out = join(dir, 'voice.mp3')
    await run(P().ffmpeg, ['-y', '-hide_banner', '-loglevel', 'error', '-i', mixed,
      '-af', `afade=t=in:d=1.5,afade=t=out:st=${Math.max(0, length - 3)}:d=3`, '-b:a', '192k', out], { log })
    return out
  }

  async function process1(job) {
    const c = cfg()
    const voice = listVoices(P().models).find((v) => v.id === (job.voice || c.voice)) || listVoices(P().models)[0]
    if (!voice && !local?.active('song')) throw new Error('还没有可用的音色模型')
    // job.pitch 用 null / undefined / '' 表示「没指定，交给自动变调」，
    // 数字 0 表示「明确要求不变调」。以前这里 Number(null)===0 且 isFinite(0) 为真，
    // 两种语义分不开，autoPitch 想「仅在未指定时生效」也做不到。
    const rawAsked = job.pitch
    const explicit = rawAsked != null && rawAsked !== '' && Number.isFinite(Number(rawAsked))
    const pitch = explicit ? Math.max(-24, Math.min(24, Math.round(Number(rawAsked)))) : Number(c.pitch) || 0
    const dir = join(work(), Date.now().toString(36))
    mkdirSync(dir, { recursive: true })
    current.stage = '下载歌曲'
    const song = job.file || (await download(job, dir))
    // 同一首歌、同一套参数做过的，直接复用
    // v3：缓存键带上全部渲染参数和音色文件指纹——否则改了 indexRate / protect / f0 还会拿到旧成品
    const stamp = (f) => {
      try { const s = statSync(f); return `${s.size}:${Math.round(s.mtimeMs)}` } catch (error) { return '0' }
    }
    // v4：母带链上线（含伴奏跟调），输出和 v3 不同，全部换新键重算
    const key = createHash('md5').update(['v4', job.songKey || song, local?.active('song') ? 'local:' + (voice?.id || '') : voice.id,
      stamp(voice?.pth), stamp(voice?.index), (explicit || c.autoPitch === false) ? pitch : 'auto', c.maxVoiceSec, c.clipStart,
      c.indexRate, c.protect, c.f0Method, c.volumeEnvelope, c.vocalVolume, c.instVolume, c.separatorModel,
      c.master === false ? 'raw' : 'master'].join('|')).digest('hex').slice(0, 16)
    const cached = join(work(), 'cache', key + '.mp3')
    if (existsSync(cached)) {
      log.info(`翻唱：「${job.title}」做过了，直接用缓存`)
      return { file: cached, voice: voice.id, pitch, dir }
    }
    current.stage = '截取要唱的那一段'
    const part = await cutFirst(song, dir, job.start)
    current.stage = '分离人声和伴奏'
    const { vocals, inst } = await separate(part.file, dir)
    // 纯音乐 / 伴奏版分不出人声：换下一首候选重做，不然发出去只有伴奏
    const vol = await meanVolume(vocals)
    if (vol < VOCAL_MIN_DB) {
      log.info(`翻唱：「${job.title}」几乎没有人声（${vol.toFixed(0)} dB），像是纯音乐`)
      try { rmSync(dir, { recursive: true, force: true }) } catch (error) {}
      if (!job.file) markNoVocals(job.songKey)
      if (job.file || job.songId) throw new Error('这首没有人声（像是纯音乐或伴奏版），换一首吧')
      job.skip = [...(job.skip || []), job.songKey]
      if (job.skip.length >= 3) throw new Error(`搜到的几版「${job.query}」都没有人声，换个说法试试（比如带上歌手名）`)
      current.stage = '换一版重下'
      return process1(job)
    }
    current.stage = '换成她的声音'
    // 机器挑的那段要是多声部（合唱 / 和声 / 叠录），RVC 只能跟其中一条人声，其余变糊音，
    // 参数怎么调都救不回来。与其闷头发一段听不懂的，不如当场说清楚该换哪一段。
    // 只在「这段是机器挑的」时候查——用户自己指定的位置，他有他的道理。
    let warn = ''
    if (part.auto) {
      current.stage = '检查这段能不能唱'
      const probe = await probeVocal(vocals)
      if (probe && probe.mono === false) {
        const at = Math.round(part.start || 0)
        warn = `这段（第 ${at} 秒起）是多声部 / 和声，换成一个人的声音会糊成一片。`
          + `换一段独唱再试：/唱 ${job.title || job.query} @秒数（不知道位置就先试 @0）`
        log.warn(`翻唱：「${job.title || job.query}」${at}s 起判为多声部`
          + `（F0 跨度 ${probe.span} 半音、置信中位 ${probe.conf_med}、有声 ${Math.round((probe.voiced || 0) * 100)}%）`)
      } else if (probe) {
        log.debug(`翻唱：人声探测通过（跨度 ${probe.span} 半音、置信中位 ${probe.conf_med}）`)
      }
    }
    let usePitch = pitch
    // 只在「没显式指定变调」时才自动算。以前是无条件覆盖，导致
    // 歌单池的 shift 表（男声 +12）、`/唱 升3个调`、工具 pitch 参数三条链路全部失效。
    if (!explicit && cfg().autoPitch !== false) {
      const auto = await detectPitch(vocals)
      if (auto) {
        usePitch = auto.shift
        log.info(`自动变调：中位 ${auto.median}Hz、高音 ${auto.p95}Hz → ${usePitch >= 0 ? '+' : ''}${usePitch} 半音`)
      }
    } else if (explicit) {
      log.info(`变调用点歌时指定的 ${usePitch >= 0 ? '+' : ''}${usePitch} 半音（跳过自动检测）`)
    }
    const converted = await convert(vocals, dir, voice, usePitch)
    // 调试用：留一份干声和转换结果，方便比对电音段（keepWork 关着也能留）
    try {
      const dbg = join(dataDir('local'), 'out')
      mkdirSync(dbg, { recursive: true })
      copyFileSync(vocals, join(dbg, 'last_vocals.wav'))
      copyFileSync(converted, join(dbg, 'last_rvc.wav'))
      log.info(`调试副本：${join(dbg, 'last_rvc.wav')}`)
    } catch (error) {
      log.warn('调试副本没存成：' + (error.message || error))
    }
    current.stage = '混音'
    const mixed = await masterMix(converted, inst, dir, usePitch)
    const out = part.cut ? await fade(mixed, dir, part.length) : mixed
    mkdirSync(join(work(), 'cache'), { recursive: true })
    copyFileSync(out, cached)
    // 缓存上限可配：条数（song.cacheMax）与总字节（song.cacheMaxGB）双限
    pruneCache(join(work(), 'cache'), Math.max(1, Number(cfg().cacheMax) || 40), Math.max(0.1, Number(cfg().cacheMaxGB) || 2))
    return { file: cached, voice: voice.id, pitch: usePitch, dir, warn }
  }

  async function pump() {
    if (current || !queue.length) return
    const job = queue.shift()
    current = { query: job.query, title: job.query, chatId: job.chatId, stage: '排队', startedAt: Date.now() }
    log.info(`翻唱开始：「${job.query}」→ ${job.chatId}`)
    try {
      const r = await process1(job)
      current.stage = '发送'
      await sendVoiceFile(job.chatId, r.file, `[翻唱] ${job.title || job.query}`)
      // 多声部提示：语音条已经发了，再补一句「为什么这段不好听、该怎么换」
      if (r.warn) sendText?.(job.chatId, r.warn).catch(() => {})
      history.unshift({ at: Date.now(), title: job.title || job.query, voice: r.voice, pitch: r.pitch, ok: true, message: `用时 ${Math.round((Date.now() - current.startedAt) / 1000)} 秒${r.warn ? '（这段是多声部，建议换段）' : ''}` })
      log.info(`翻唱完成：「${job.title || job.query}」`)
      onSung?.(job.title || job.query, job.chatId)
      if (!cfg().keepWork) try { rmSync(r.dir, { recursive: true, force: true }) } catch (error) {}
    } catch (error) {
      const why = explainSongError(error.message)
      history.unshift({ at: Date.now(), title: job.title || job.query, ok: false, message: why })
      log.warn(`翻唱失败：「${job.query}」：`, error.message)
      sendText?.(job.chatId, `唱不了「${job.title || job.query}」：${why}`).catch(() => {})
    } finally {
      // 唱完 / 唱不了都算这件事了结：让「承诺追踪」别再隔几分钟补一句「让你久等啦」
      try { onSettled?.(job.chatId) } catch (error) {}
      history = history.slice(0, 20)
      current = null
      pump()
    }
  }

  /** 点一首：马上返回，做好了自己发到聊天里。 */
  function request({ song, songId, file, pitch, voice, chatId, start }) {
    const c = cfg()
    if (!c.enabled) return { ok: false, message: '翻唱还没打开（面板「翻唱」标签里开）' }
    const st = status()
    if (!st.ready) return { ok: false, message: '翻唱环境还没装好：' + st.message }
    if (!song && !songId && !file) return { ok: false, message: '要说唱哪首歌' }
    // 排队上限可配（song.maxQueue），默认 5
    const maxQueue = Math.max(1, Number(cfg().maxQueue) || 5)
    if (queue.length >= maxQueue) return { ok: false, message: `排队的歌太多了（上限 ${maxQueue} 首），等会儿再点` }
    queue.push({ query: song || basename(file || ''), songId, file, pitch, voice, chatId, start })
    const ahead = queue.length - 1 + (current ? 1 : 0)
    pump()
    return { ok: true, message: `开始准备「${song || basename(file || '')}」，大概要两三分钟${ahead ? `（前面还有 ${ahead} 首）` : ''}，做好了会直接发语音` }
  }

  return {
    status,
    install: () => { runInstall(); return { ok: true, message: '开始安装，要下载好几个 GB，可能要十几分钟' } },
    request,
    search: (q) => searchSongs(q, { cookie: cfg().neteaseCookie, limit: 8 }),
    account: () => account(cfg().neteaseCookie),
    voices: () => listVoices(P().models).map((v) => v.id),
    // .ckpt 是手动下好的人声分离模型，其余是音色
    importModels: (filename, buf) => (/\.ckpt$/i.test(filename) ? importSeparator(P().separatorModels, filename, buf) : importModels(P().models, filename, buf)),
    separatorLinks: () => separatorLinks(cfg().separatorModel),
    deleteVoice: (id) => deleteVoice(P().models, id),
  }
}
