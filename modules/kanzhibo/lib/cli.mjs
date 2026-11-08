#!/usr/bin/env node
// lib/cli.mjs —— 看直播的命令行（零依赖，不经过模型）。
//
// 为什么有这个：原来查状态、跑体检、看候选、走一遍「准备」都得**现写一段脚本**，
// 每次都要重新读接口、拼参数、看一串 JSON。现在这些都固定成命令，
// 人和脚本用同一套：输出可 diff、可进 CI、出了问题能原样重放。
//
// 用法（在模块目录里）：
//   node lib/cli.mjs status
//   node lib/cli.mjs pending
//   node lib/cli.mjs confirm | cancel
//   node lib/cli.mjs selfcheck
//   node lib/cli.mjs probe badge --open --shot
//   node lib/cli.mjs probe gift --name 小心心 --open --shot
//   node lib/cli.mjs probe text --q 点亮
//   node lib/cli.mjs doctor
//   node lib/cli.mjs verify [--live]
//
// 找面板地址：--base <url> > 环境变量 AURABOT_BASE > 扫本机监听端口找 /aurabot/api/state。
// 退出码：0 成功；1 模块报错；2 找不到面板 / 请求失败。

import { execFileSync } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const MOD_DIR = dirname(HERE)

const HELP = [
  '看直播 · 命令行',
  '',
  '  status                     看挂直播/刷抖音/时段/当前的原始状态',
  '  pending                    看有没有在等你确认的动作',
  '  confirm | cancel           同意 / 撤销那个待确认的动作',
  '  selfcheck                  体检单（浏览器、CDP、视口、今日评论/灯牌）',
  '  probe <what> [flags]       探针：badge / gift / text / info / pagetext / hit / prep / prepgift / mark / expiry',
  '  doctor                     面板能不能连上、模块在不在跑、版本对不对',
  '  verify [--live]            跑模块自检（--live 会真起一次浏览器）',
  '',
  'flags:',
  '  --base <url>               面板地址，如 http://127.0.0.1:49509',
  '  --target <url>             临时指定直播间（不进设置）',
  '  --name <礼物名>            probe gift / prepgift 用，默认 小心心',
  '  --q <文字>                 probe text 用',
  '  --open                     探针允许做「不花钱」的点击（打开面板）',
  '  --shot                     探针顺手截图（路径会在输出里）',
  '  --esc                      先按 Esc 关掉可能开着的面板',
  '  --json                     输出原始 JSON（给脚本用）',
  '',
  '环境变量：AURABOT_BASE（面板地址）',
].join('\n')

function parseArgs(argv) {
  const flags = {}
  const rest = []
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    if (a === '--json' || a === '--open' || a === '--shot' || a === '--esc' || a === '--live') { flags[a.slice(2)] = true; continue }
    if (a.startsWith('--')) {
      const key = a.slice(2)
      const val = argv[i + 1]
      if (val === undefined || val.startsWith('--')) { flags[key] = true; continue }
      flags[key] = val; i++
      continue
    }
    rest.push(a)
  }
  return { flags, rest }
}

function listeningPorts() {
  const ports = new Set()
  try {
    if (process.platform === 'win32') {
      const out = execFileSync('netstat', ['-ano', '-p', 'tcp'], { encoding: 'utf8', timeout: 5000, windowsHide: true })
      for (const line of out.split(/\r?\n/)) {
        const m = /^\s*TCP\s+(\S+):(\d+)\s+\S+\s+LISTENING/i.exec(line)
        if (!m) continue
        const host = m[1]
        if (!(host === '127.0.0.1' || host === '0.0.0.0' || host === '[::]' || host === '[::1]')) continue
        ports.add(Number(m[2]))
      }
      return [...ports]
    }
    try {
      const out = execFileSync('ss', ['-ltn'], { encoding: 'utf8', timeout: 5000 })
      for (const line of out.split(/\r?\n/).slice(1)) {
        const m = /\s(?:\S*:)(\d+)\s/.exec(line)
        if (m) ports.add(Number(m[1]))
      }
    } catch {
      const out = execFileSync('lsof', ['-nP', '-iTCP', '-sTCP:LISTEN'], { encoding: 'utf8', timeout: 5000 })
      for (const line of out.split(/\r?\n/).slice(1)) {
        const m = /:(\d+)\s+\(LISTEN\)/.exec(line)
        if (m) ports.add(Number(m[1]))
      }
    }
  } catch {}
  return [...ports]
}

async function stateAt(base) {
  try {
    const r = await fetch(base + '/aurabot/api/state', { signal: AbortSignal.timeout(900) })
    if (!r.ok) return null
    const j = await r.json()
    return j && j.ok && Array.isArray(j.modules) ? j : null
  } catch {
    return null
  }
}

async function detectBase(flags) {
  const tried = []
  const explicit = flags.base || process.env.AURABOT_BASE || process.env.AURABOT_URL
  if (explicit) {
    const base = String(explicit).replace(/\/$/, '')
    const st = await stateAt(base)
    return st ? { base, state: st } : null
  }
  const ports = [...new Set([49509, 52839, 63654, 58608, ...listeningPorts()])].filter((p) => p > 0 && p < 65536)
  tried.push(...ports)
  const bases = ports.map((p) => 'http://127.0.0.1:' + p)
  const results = await Promise.all(bases.map(async (b) => ({ b, st: await stateAt(b) })))
  for (const r of results) if (r.st) return { base: r.b, state: r.st }
  return { base: '', state: null, tried }
}

async function call(base, path) {
  const r = await fetch(base + path, { signal: AbortSignal.timeout(120000) })
  const text = await r.text()
  let json = null
  try { json = JSON.parse(text) } catch {}
  return { status: r.status, ok: r.ok, text, json }
}

function moduleOf(state) {
  return (state.modules || []).find((m) => m.id === 'kanzhibo') || null
}

function printStatus(m, state, base) {
  if (!m) { console.log('模块没在跑（面板「已安装」里看一下）'); return }
  const r = m.running === 'user' ? '在跑' : (m.running ? m.running : '没在跑')
  console.log('面板：' + base)
  console.log('模块：' + m.name + ' ' + m.version + '（' + r + '）' + (m.error ? ' 错误：' + m.error : ''))
  const cfg = (state.config && state.config.ext && state.config.ext.kanzhibo) || {}
  const defs = m.defaults || {}
  const v = (k) => (cfg[k] === undefined ? defs[k] : cfg[k])
  console.log('挂直播：' + (v('enabled') ? '开' : '关') + '｜时段：' + (v('schedule') ? v('startTime') + '-' + v('endTime') : '不限') + '｜模式：' + (v('semiAuto') ? '半自动' : '自动'))
  console.log('目标：' + (v('target') || '没填'))
  console.log('房间：' + (v('liveCommentOn') ? '评论开' : '评论关') + '｜灯牌：' + (v('renewBadge') ? '开' : '关') + '｜送礼：' + (v('giftByDm') ? '开' : '关'))
}

const { flags, rest } = parseArgs(process.argv.slice(2))
const cmd = rest[0] || 'help'

if (cmd === 'help' || flags.help) { console.log(HELP); process.exit(0) }

if (cmd === 'verify') {
  const args = [join(MOD_DIR, 'test', 'verify.mjs')]
  const env = { ...process.env }
  if (flags.live) env.LIVE = '1'
  try {
    execFileSync(process.execPath, args, { cwd: MOD_DIR, stdio: 'inherit', env })
    process.exit(0)
  } catch (e) { process.exit(e.status || 1) }
}

const found = (await detectBase(flags)) || { base: '', state: null }
if (!found.base) {
  const tried = found.tried || []
  console.error('找不到面板：' + (tried.length ? '试过 ' + tried.length + ' 个端口' : '你给的地址连不上') + '。用 --base http://127.0.0.1:<端口> 指一下，或设 AURABOT_BASE。')
  process.exit(2)
}
const base = found.base
const mod = moduleOf(found.state)

if (cmd === 'doctor') {
  if (flags.json) { console.log(JSON.stringify({ base, module: mod && { id: mod.id, version: mod.version, running: mod.running, error: mod.error } }, null, 2)); process.exit(0) }
  console.log('面板：' + base + '（连上了）')
  console.log('插件：' + (found.state.version || '?') + ' · 扩展接口 v' + (found.state.apiVersion || '?'))
  printStatus(mod, found.state, base)
  console.log('CLI：' + join(HERE, 'cli.mjs'))
  process.exit(0)
}

if (cmd === 'status') {
  if (flags.json) { console.log(JSON.stringify(mod, null, 2)); process.exit(0) }
  printStatus(mod, found.state, base)
  if (mod && mod.errors && mod.errors.length) console.log('最近报错：' + mod.errors[0].message)
  process.exit(mod ? 0 : 1)
}

if (cmd === 'pending') {
  const r = await call(base, '/aurabot/api/ext/kanzhibo/pending')
  if (!r.json) { console.error(r.text.slice(0, 200)); process.exit(1) }
  if (flags.json) { console.log(JSON.stringify(r.json, null, 2)); process.exit(0) }
  const p = r.json.pending
  console.log(p ? ('等你确认：' + p.label + '（' + Math.round((p.leftMs || 0) / 1000) + ' 秒后作废）') : '没有等你确认的事')
  process.exit(0)
}

if (cmd === 'confirm' || cmd === 'cancel') {
  const r = await call(base, '/aurabot/api/ext/kanzhibo/probe?what=' + (cmd === 'confirm' ? 'ok' : 'no'))
  if (!r.json) { console.error(r.text.slice(0, 200)); process.exit(1) }
  if (flags.json) { console.log(JSON.stringify(r.json, null, 2)); process.exit(0) }
  console.log((r.json.result && r.json.result.message) || (r.json.ok ? '好了' : '没成功'))
  process.exit(r.json.ok ? 0 : 1)
}

if (cmd === 'selfcheck') {
  const r = await call(base, '/aurabot/api/ext/kanzhibo/selfcheck')
  if (!r.json) { console.error(r.text.slice(0, 200)); process.exit(1) }
  if (flags.json) { console.log(JSON.stringify(r.json, null, 2)); process.exit(0) }
  console.log(r.json.text || JSON.stringify(r.json, null, 2))
  process.exit(0)
}

if (cmd === 'probe') {
  const what = rest[1] || 'info'
  const qs = new URLSearchParams({ what })
  if (flags.target) qs.set('target', String(flags.target))
  if (flags.name) qs.set('name', String(flags.name))
  if (flags.q) qs.set('q', String(flags.q))
  if (flags.x !== undefined) qs.set('x', String(flags.x))
  if (flags.y !== undefined) qs.set('y', String(flags.y))
  if (flags.open) qs.set('open', '1')
  if (flags.shot) qs.set('shot', '1')
  if (flags.esc) qs.set('esc', '1')
  const r = await call(base, '/aurabot/api/ext/kanzhibo/probe?' + qs.toString())
  if (!r.json) { console.error(r.text.slice(0, 300)); process.exit(1) }
  if (flags.json) { console.log(JSON.stringify(r.json, null, 2)); process.exit(r.json.ok ? 0 : 1) }
  // 人看的摘要：先给结论，再挑有用的字段
  const j = r.json
  console.log('结果：' + (j.ok ? 'ok' : '失败') + (j.message ? ' · ' + j.message : ''))
  if (j.pending) console.log('待确认：' + JSON.stringify(j.pending))
  for (const k of ['url', 'title', 'viewport', 'entry', 'candidates', 'confirmCandidates', 'badgePrep', 'giftPrep', 'marked', 'shot', 'shotFull', 'shotZoom', 'at', 'info', 'matches', 'length', 'hasRecharge', 'hasBadge', 'balance', 'head']) {
    if (j[k] === undefined) continue
    const v = j[k]
    if (v && typeof v === 'object' && Array.isArray(v.list)) console.log(k + '：' + v.total + ' 个 → ' + v.list.slice(0, 6).map((x) => x.text + '@' + x.rect.left + ',' + x.rect.top).join(' | '))
    else if (v && typeof v === 'object' && v.ok !== undefined) console.log(k + '：' + (v.ok ? 'ok' : '不 ok') + (v.reason ? ' · ' + v.reason : ''))
    else if (typeof v !== 'object') console.log(k + '：' + v)
    else console.log(k + '：' + JSON.stringify(v).slice(0, 200))
  }
  process.exit(j.ok ? 0 : 1)
}

console.log(HELP)
process.exit(0)
